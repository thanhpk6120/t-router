// TTFT gate — the rung a timeout ladder actually measures.
//
// Why this module exists
// ----------------------
// A ladder bound to "time until response HEADERS arrive" does nothing for
// streaming: an SSE upstream answers 200 and its headers in ~100ms, the connect
// timer is cleared, and the model then thinks for 40s. Bậc 1 never chạm.
// So the rung deadline has to cover the FIRST TOKEN, which only exists in the
// response BODY.
//
// The gate therefore peeks the body for a real payload line and hands back a
// Response that still delivers every byte it consumed. Nothing was written to
// the client at that point, so a rung timeout is safe to discard: the executor
// cancels this response, rotates to the next rung, and re-issues the model call.
//
// Once a payload line is seen the request is a success by definition. The gate
// never reports a timeout after that — the caller got its answer.
import { dbg } from "./debugLog.js";
import { getResponseProxyInfo, tagProxyUsed } from "./proxyProvenance.js";

/**
 * Raised when a rung deadline expires with no payload — i.e. the attempt is
 * retryable, not failed. Marked so the executor can tell it apart from a real
 * network error without string matching.
 */
export class TtftRungTimeout extends Error {
  constructor(message) {
    super(message);
    this.name = "TtftRungTimeout";
    this.ttftRungExhausted = true;
  }
}

// SSE needs a real ANSWER, not just a frame. Three things must NOT count:
//   1. heartbeats — `: keep-alive`, `retry: 1000`, blank lines;
//   2. metadata events — Anthropic `message_start` / `content_block_start`
//      arrive ~200ms after headers with the model still thinking;
//   3. `[DONE]` sentinels.
// Counting those would pass every rung instantly and leave the ladder inert,
// which is exactly the bug this gate exists to fix. So each `data:` payload is
// parsed, and only counts when it carries text, reasoning, or tool-call bytes.
const CONTENT_KEYS = new Set([
  "content",
  "text",
  "reasoning",
  "reasoning_content",
  "thinking",
  "partial_json",
  "partial_text",
  "arguments",
  "output_text",
  "completion",
  "token",
]);

// Event types that announce the turn began rather than emitting output.
const METADATA_EVENTS =
  /^(?:message_start|message_delta|message_stop|content_block_start|content_block_stop|ping|response\.(?:created|in_progress|completed|output_item\.added|output_item\.done|content_part\.added|content_part\.done))$/;

function decode(chunk) {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  return "";
}

/** Non-empty string leaf under a content key, at bounded depth. */
function scanForContent(node, depth = 0) {
  if (node == null || depth > 6) return false;
  if (typeof node === "string") return node.length > 0;
  if (Array.isArray(node)) return node.some((v) => scanForContent(v, depth + 1));
  if (typeof node !== "object") return false;

  for (const [key, value] of Object.entries(node)) {
    if (CONTENT_KEYS.has(key)) {
      if (typeof value === "string") {
        if (value.length > 0) return true;
      } else if (value != null && typeof value === "object") {
        if (scanForContent(value, depth + 1)) return true;
      }
    }
    // Wrapper objects (`{"delta":{...}}`, `{"choices":[...]}`) must be walked
    // even when their own key is not a content key.
    if (value != null && typeof value === "object" && scanForContent(value, depth + 1)) {
      return true;
    }
  }
  return false;
}

/** Does this SSE text carry actual output? */
function sseHasAnswer(text) {
  if (!text) return false;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith(":") ||
      trimmed.startsWith("event:") ||
      trimmed.startsWith("retry:") ||
      trimmed.startsWith("id:")
    ) {
      continue;
    }

    const body = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    if (!body || body === "[DONE]") continue;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Not JSON: a plain-text stream. Real bytes, so it is an answer.
      return true;
    }

    if (parsed && typeof parsed === "object") {
      const eventType = String(parsed.type || parsed.event || "");
      if (METADATA_EVENTS.test(eventType)) continue;
      if (scanForContent(parsed)) return true;
      continue;
    }

    // A bare JSON scalar (`data: "hi"`) is output.
    if (typeof parsed === "string" || typeof parsed === "number") return true;
  }

  return false;
}

/**
 * Does this chunk carry output?
 *
 * SSE is parsed (see above). A non-SSE body (JSON for a non-streaming request)
 * has no framing to skip: the first non-empty bytes ARE the answer, because a
 * non-streaming upstream only sends its body once the model has finished.
 */
/**
 * Does this chunk carry output?
 *
 * Unknown content-type defaults to SSE: a missing header means we cannot rule
 * out framing, and assuming "raw bytes are output" would let an upstream that
 * only drips `data: {}` heartbeats satisfy the gate while its model hangs.
 * The SSE parser also handles a bare JSON body (one line, JSON.parse succeeds),
 * so it is the safe superset. `isSse: false` is only for a body KNOWN to be
 * non-streaming JSON, where the first bytes really are the answer.
 */
function chunkCarriesPayload(chunk, isSse) {
  if (!chunk) return false;
  if (sseHasAnswer(decode(chunk))) return true;
  if (isSse === false) return (chunk.byteLength || chunk.length || 0) > 0;
  return false;
}

/**
 * Shared "is this real output?" test.
 *
 * The stall watchdog and the TTFT gate must agree on this or the two disagree in
 * production: a provider that only sends heartbeats would keep the watchdog
 * alive while the gate times out, and the request would hang instead of retry.
 *
 * @param {Uint8Array|string} chunk
 * @param {boolean} isSse
 * @returns {boolean}
 */
export function carriesOutput(chunk, isSse = true) {
  if (!chunk) return false;
  return chunkCarriesPayload(chunk, isSse);
}

/**
 * Wait for the first payload line in `response.body`, or fail the rung.
 *
 * @param {Response} response        upstream response (headers already arrived)
 * @param {number} budgetMs          remaining rung budget, measured from attempt start
 * @param {object} [ctx]
 * @param {string} [ctx.provider]
 * @param {number} [ctx.rung]        1-based rung index, for the debug line
 * @param {number} [ctx.totalRungs]
 * @param {object} [ctx.log]
 * @returns {Promise<Response>} a Response replaying the buffered bytes, or throws TtftRungTimeout
 */
export async function gateFirstToken(response, budgetMs, ctx = {}) {
  const { provider = "?", rung = 1, totalRungs = 1, log = null } = ctx;

  // No body to inspect (204/304, or an executor that already consumed it):
  // nothing to gate, and inventing a timeout here would break a valid path.
  if (!response || !response.body || typeof response.body.getReader !== "function") {
    return response;
  }

  const reader = response.body.getReader();
  const buffered = [];
  const deadline = Date.now() + Math.max(0, Number(budgetMs) || 0);
  let timer = null;
  // Non-streaming requests return JSON, not SSE: no framing to skip, so the
  // first bytes are already the first token.
  const contentType = (response.headers?.get?.("content-type") || "").toLowerCase();
  const isSse = contentType.includes("text/event-stream");
  const decoder = new TextDecoder();
  let sseCarry = "";

  const rungTimeout = (why) =>
    new TtftRungTimeout(
      `[TTFT] no first token within rung ${rung}/${totalRungs} (${budgetMs}ms): ${why}`,
    );

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw rungTimeout("rung budget already spent on headers");

      // read() has no timeout of its own; the race is what turns a hung
      // upstream into a retryable rung miss instead of a stuck request.
      const outcome = await Promise.race([
        reader.read().then((r) => ({ kind: "chunk", r })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
        }),
      ]);
      if (timer) { clearTimeout(timer); timer = null; }

      if (outcome.kind === "timeout") throw rungTimeout("upstream silent");

      const { done, value } = outcome.r;
      if (done) {
        if (isSse && sseCarry) {
          const tail = sseCarry + decoder.decode();
          if (sseHasAnswer(tail)) break;
        }
        // Clean EOF with only heartbeats (or nothing): the model produced no
        // output, so this rung failed exactly like a silent upstream.
        throw rungTimeout("stream ended before any payload");
      }

      buffered.push(value);
      if (isSse) {
        sseCarry += typeof value === "string" ? value : decoder.decode(value, { stream: true });
        const lastNl = sseCarry.lastIndexOf("\n");
        if (lastNl >= 0) {
          const complete = sseCarry.slice(0, lastNl + 1);
          sseCarry = sseCarry.slice(lastNl + 1);
          if (sseHasAnswer(complete)) break;
        }
      } else if (chunkCarriesPayload(value, false)) {
        break;
      }
    }
  } catch (error) {
    // Discarded attempt: release the socket and the upstream request. Without
    // the cancel the abandoned body keeps the connection alive and the retry
    // contends with a stream nobody is reading.
    try { await reader.cancel(error); } catch { /* already closed */ }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (rung > 1 || buffered.length > 1) {
    dbg("TTFT", `${provider} first token on rung ${rung}/${totalRungs} (${buffered.length} buffered chunk(s))`);
  }

  // Replay what the gate consumed, then hand the rest of the body straight
  // through. Backpressure is preserved by reading inside pull().
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });

  const rebuilt = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  // Provenance lives in a WeakMap keyed by the Response object, so the wrapper
  // starts untagged. Without this the dashboard would lose the proxy badge for
  // exactly the requests that went through a ladder.
  const info = getResponseProxyInfo(response);
  if (info) {
    tagProxyUsed(rebuilt, info);
    if (log?.debug) log.debug("TTFT", `${provider} re-tagged rebuilt response as proxy=${info.proxied}`);
  }

  return rebuilt;
}

export default gateFirstToken;

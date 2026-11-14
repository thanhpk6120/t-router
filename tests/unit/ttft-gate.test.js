// TTFT gate + stall-after-output policy.
//
// Two requirements are locked here:
//   1. A rung that expires must ADVANCE to the next rung and re-issue the model
//      call — not surface an error. The rung budget covers the FIRST TOKEN, so
//      an upstream that answers headers in 100ms and then thinks still trips it.
//   2. Once output has streamed, ending the stream is a success: no error frame,
//      no FAILED row. Only a silent upstream (headers and nothing else) fails.
//
// Run from tests/:
//   bun x vitest run unit/ttft-gate.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, options, ...rest) => {
    if (!options || typeof options !== "object" || !("connectTimeoutMs" in options)) {
      return Promise.resolve({ status: 200, headers: { get: () => "" } });
    }
    return fetchMock(url, options, ...rest);
  },
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { gateFirstToken, TtftRungTimeout } = await import("../../open-sse/utils/ttftGate.js");
const { pipeWithDisconnect, createStreamController } = await import("../../open-sse/utils/streamHandler.js");

const enc = (s) => new TextEncoder().encode(s);

const creds = { apiKey: "k" };

/** SSE response whose body emits `chunks` after `delayMs`, then stays open. */
function sseResponse({ delayMs = 0, chunks = [], contentType = "text/event-stream" } = {}) {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      if (chunks.length) {
        setTimeout(() => {
          for (const c of chunks) {
            if (!cancelled) controller.enqueue(typeof c === "string" ? enc(c) : c);
          }
        }, delayMs);
      }
    },
    cancel() { cancelled = true; },
  });
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

const DELTA = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n';
const MESSAGE_START = 'event: message_start\ndata: {"type":"message_start","message":{"role":"assistant","content":[]}}\n\n';
const HEARTBEAT = ": keep-alive\n\n";

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function runLadder(exec, overrides, advanceMs) {
  vi.useFakeTimers();
  const p = exec.execute({
    model: "m",
    body: {},
    stream: true,
    credentials: creds,
    signal: null,
    log: { debug: vi.fn(), warn: vi.fn() },
    providerOverrides: overrides,
  });
  const settled = p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
  await vi.advanceTimersByTimeAsync(advanceMs);
  return settled;
}

/** Read whatever the stream yields within `ms`, then stop. Avoids hanging on an open body. */
async function drain(body, ms = 120) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const step = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: true, timeout: true }), Math.max(1, deadline - Date.now()))),
    ]);
    if (step.done) break;
    out += decoder.decode(step.value);
  }
  await reader.cancel().catch(() => {});
  return out;
}

describe("gateFirstToken — what counts as the first token", () => {
  it("passes immediately when the first chunk carries text", async () => {
    const gated = await gateFirstToken(sseResponse({ chunks: [DELTA] }), 5000);
    expect(gated.status).toBe(200);
    expect(await drain(gated.body)).toContain("hello");
  });

  it("ignores a heartbeat-only upstream and times out", async () => {
    const res = sseResponse({ chunks: [HEARTBEAT, HEARTBEAT] });
    await expect(gateFirstToken(res, 30)).rejects.toBeInstanceOf(TtftRungTimeout);
  });

  it("ignores message_start: the turn began, the model has not answered", async () => {
    const res = sseResponse({ chunks: [MESSAGE_START, HEARTBEAT] });
    await expect(gateFirstToken(res, 30)).rejects.toBeInstanceOf(TtftRungTimeout);
  });

  it("treats a non-SSE (JSON) body as answered — it only arrives when done", async () => {
    const res = sseResponse({
      chunks: ['{"choices":[{"message":{"content":"hi"}}]}'],
      contentType: "application/json",
    });
    const gated = await gateFirstToken(res, 5000);
    expect(gated.status).toBe(200);
  });

  it("returns a response with no body untouched", async () => {
    const bare = { status: 204, headers: { get: () => "" } };
    expect(await gateFirstToken(bare, 10)).toBe(bare);
  });

  it("replays every byte it buffered, so no output is lost", async () => {
    const gated = await gateFirstToken(sseResponse({ chunks: [HEARTBEAT, DELTA] }), 5000);
    const text = await drain(gated.body);
    expect(text).toContain("keep-alive");
    expect(text).toContain("hello");
  });

  it("does not open early when a metadata frame is split across chunks", async () => {
    const half1 = 'event: message_start\ndata: {"type":"message_sta';
    const half2 = 'rt","message":{"role":"assistant","content":[]}}\n\n';
    const res = sseResponse({ chunks: [half1, half2] });
    await expect(gateFirstToken(res, 30)).rejects.toBeInstanceOf(TtftRungTimeout);
  });
});

describe("BaseExecutor — a rung timeout advances, it does not fail", () => {
  it("retries the same URL with the next rung when the stream stays silent", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockImplementation(() => Promise.resolve(sseResponse()));

    const out = await runLadder(exec, { timeoutLadder: [5, 10] }, 5000 + 250 + 10000 + 200);

    expect(out.ok).toBe(false);
    // Both rungs were attempted, each with its own budget — the ladder walked.
    expect(fetchMock.mock.calls.map((c) => c[1].connectTimeoutMs)).toEqual([5000, 10000]);
  });

  it("succeeds as soon as a later rung produces a first token", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    let call = 0;
    fetchMock.mockImplementation(() => {
      call++;
      // First rung: silent. Second rung: the model finally answers.
      return Promise.resolve(call === 1 ? sseResponse() : sseResponse({ chunks: [DELTA] }));
    });

    const out = await runLadder(exec, { timeoutLadder: [5, 30] }, 5000 + 250 + 500);

    expect(out.ok).toBe(true);
    expect(out.v.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not gate the body when no ladder is configured", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockImplementation(() => Promise.resolve(sseResponse()));

    const out = await runLadder(exec, null, 100);

    // Headers-only success, exactly as before the feature existed.
    expect(out.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands over to the fallback URL once the ladder is spent", async () => {
    const exec = new BaseExecutor("test", { baseUrls: ["https://a/api", "https://b/api"] });
    fetchMock.mockImplementation(() => Promise.resolve(sseResponse()));

    const out = await runLadder(exec, { timeoutLadder: [5, 10] }, (5000 + 250 + 10000 + 250) * 2 + 300);

    expect(out.ok).toBe(false);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://a/api",
      "https://a/api",
      "https://b/api",
      "https://b/api",
    ]);
  });

  it("returns HTTP error responses with empty body directly without gating or retrying", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    const emptyErr = new Response(new ReadableStream({ start(c) { c.close(); } }), {
      status: 401,
      headers: { "content-type": "text/plain" },
    });
    fetchMock.mockResolvedValueOnce(emptyErr);

    const out = await exec.execute({
      model: "m",
      body: {},
      stream: true,
      credentials: creds,
      signal: null,
      log: { debug: vi.fn(), warn: vi.fn() },
      providerOverrides: { timeoutLadder: [5, 10] },
    });

    expect(out.response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("pipeWithDisconnect — output flowed means success", () => {
  function pipe({ chunks, delayMs, stallTimeoutMs = 30 }) {
    const errors = [];
    let upstreamCtrl = null;
    // Upstream body we can terminate, so a pending pull() settles after the
    // assertions instead of hanging on a stream that never emits.
    const body = new ReadableStream({
      start(controller) {
        upstreamCtrl = controller;
        if (chunks.length) {
          setTimeout(() => {
            for (const c of chunks) {
              try { controller.enqueue(typeof c === "string" ? enc(c) : c); } catch { /* closed */ }
            }
          }, delayMs);
        }
      },
    });
    const providerResponse = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const controller = createStreamController({ onError: (e) => errors.push(e), provider: "t", model: "m" });
    const terminal = vi.fn(() => enc('data: {"error":"timeout"}\n\n'));
    const out = pipeWithDisconnect(
      providerResponse,
      new TransformStream(),
      controller,
      terminal,
      stallTimeoutMs,
      0,
    );
    const endUpstream = () => {
      try { upstreamCtrl?.error(new Error("test: upstream ended")); } catch { /* already */ }
      try { upstreamCtrl?.close(); } catch { /* already */ }
    };
    return { out, errors, terminal, endUpstream };
  }

  it("closes cleanly after a stall that happened AFTER output", async () => {
    const { out, errors, terminal, endUpstream } = pipe({ chunks: [DELTA] });
    const reader = out.getReader();
    expect((await reader.read()).done).toBe(false);

    await new Promise((r) => setTimeout(r, 120));

    expect(errors).toHaveLength(0);
    expect(terminal).not.toHaveBeenCalled();
    endUpstream();
    await reader.cancel().catch(() => {});
  });

  it("still reports a stall before any output", async () => {
    const { out, errors, endUpstream } = pipe({ chunks: [] });
    const reader = out.getReader();
    const reading = reader.read().catch(() => {});

    await new Promise((r) => setTimeout(r, 120));

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("stall timeout");
    endUpstream();
    await reading;
    await reader.cancel().catch(() => {});
  });

  it("does not count heartbeats as output", async () => {
    const { out, errors, endUpstream } = pipe({ chunks: [HEARTBEAT], delayMs: 0 });
    const reader = out.getReader();
    const reading = reader.read().catch(() => {});

    await new Promise((r) => setTimeout(r, 150));

    // A provider that only pings while its model hangs has not answered.
    expect(errors.length).toBe(1);
    endUpstream();
    await reading;
    await reader.cancel().catch(() => {});
  });
});

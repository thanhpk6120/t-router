// Live proof that a rung timeout advances instead of erroring, and that a
// stream which produced output is never reported as a timeout.
//
// Runs the real BaseExecutor against a local upstream that answers headers
// immediately (like every SSE provider) and then withholds the first token.
//   node scripts/verify-ttft-ladder.mjs
import http from "node:http";

const state = {
  /** Per-request behaviour: index 0..n of this provider's attempts. */
  attempts: [],
};

// Upstream: headers in ~5ms, then behaviour decided by the attempt number.
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const n = state.attempts.length;
    state.attempts.push(Date.now());
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Node buffers headers until the first write; flushing is what makes this
    // upstream behave like a real SSE provider (headers in ~5ms, token later).
    res.flushHeaders();

    // Attempt 1: silent forever (must trip rung 1).
    // Attempt 2: message_start + heartbeats, then silent (must trip rung 2 —
    //            metadata is not a first token).
    // Attempt 3: real content (must succeed).
    if (n === 0) {
      return;
    }
    if (n === 1) {
      res.write('event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n');
      const beat = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch { clearInterval(beat); } }, 50);
      req.on("close", () => clearInterval(beat));
      return;
    }
    res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n');
  });
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)),
  ]);
}

const port = await listen(server);
const baseUrl = `http://127.0.0.1:${port}/v1/chat`;

const { BaseExecutor } = await import("../open-sse/executors/base.js");

const exec = new BaseExecutor("demo", { baseUrl });
const logLines = [];
const log = {
  debug: (tag, msg) => logLines.push(`[${tag}] ${msg}`),
  warn: (tag, msg) => logLines.push(`[${tag}] WARN ${msg}`),
};

const t0 = Date.now();
let result = null;
let error = null;
try {
  result = await withTimeout(
    exec.execute({
      model: "demo-model",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "test" },
      signal: null,
      log,
      providerOverrides: { timeoutLadder: [1, 2, 5] },
    }),
    20_000,
    "ladder run",
  );
} catch (e) {
  error = e;
}
const elapsed = Date.now() - t0;

let firstToken = null;
if (result?.response?.body) {
  const reader = result.response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    if (text.includes("hello")) { firstToken = text.trim(); break; }
  }
  await reader.cancel().catch(() => {});
}

server.close();

const checks = [
  ["upstream was called 3 times (2 rung timeouts, then success)", state.attempts.length === 3],
  ["the request did not surface an error", error === null],
  ["the winner carried real content", Boolean(firstToken?.includes("hello"))],
  ["rung 1 expired", logLines.some((l) => l.includes("rung 1/3 expired"))],
  ["rung 2 expired (metadata+heartbeats are not a first token)", logLines.some((l) => l.includes("rung 2/3 expired"))],
  ["no ERROR-level line was produced for a rung expiry", !logLines.some((l) => /ERROR/.test(l))],
];

console.log(`\nattempts: ${state.attempts.length} | elapsed: ${elapsed}ms`);
for (const line of logLines) console.log("  " + line);
if (error) console.log("  ERROR: " + error.message);
console.log("");
let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}
console.log(ok ? "\nTTFT ladder verified." : "\nTTFT ladder FAILED.");
process.exit(ok ? 0 : 1);

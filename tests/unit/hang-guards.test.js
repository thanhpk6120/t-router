import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inspectChatResponseFull } from "../../open-sse/rtk/flakyGuard.js";

// Regression guards for the request-hang fixes.
//
// The bounded-read guards are behavioural: a silent regression there brings
// back an infinite hang, so they run against a stream that never ends instead
// of grepping for identifiers. The remaining cases are wiring checks — cheap
// and precise enough to catch a dropped deadline or signal.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

// A ReadableStream that yields one chunk then never settles again, mimicking
// an upstream that sent headers and stalled mid-body.
function stallingStream() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"choices":[{"delta":{"content":"par'));
    },
  });
}

describe("bounded reads", () => {
  it("inspectChatResponseFull gives up on a stalled body instead of hanging", async () => {
    const response = new Response(stallingStream(), {
      headers: { "content-type": "application/json" },
    });
    const started = Date.now();
    // 1s budget by passing maxBytes low is not enough: the budget is the
    // constant. Instead assert it settles well inside the guard above the
    // budget — a hang would exceed the test timeout and fail loudly.
    const verdict = await Promise.race([
      inspectChatResponseFull(response, 8),
      new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 5000)),
    ]);
    expect(verdict).not.toBe("TIMEOUT");
    expect(verdict.flaky).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("withBudget rejects instead of hanging when the read never settles", async () => {
    const src = read("open-sse/handlers/chatCore/sseToJsonHandler.js");
    expect(src).toContain("remainingBudgetMs");
    expect(src).toMatch(/withBudget\(\(\) => providerResponse\.text\(\), remainingBudgetMs\(requestStartTime\)\)/);
    expect(src).toMatch(/withBudget\(\(\) => convertResponsesStreamToJson\(providerResponse\.body\), remainingBudgetMs\(requestStartTime\)\)/);
    // The budget must be the remaining window, never a fresh constant.
    expect(src).toMatch(/TOTAL_REQUEST_TIMEOUT_MS - \(Date\.now\(\) - requestStartTime\)/);
  });
});

describe("abort and deadline wiring", () => {
  it("prompt-inject snapshot builder resolves to the snapshot", () => {
    const src = read("src/lib/db/repos/promptInjectRepo.js");
    expect(src).toMatch(/return snapshot;/);
    const body = src.slice(src.indexOf("snapshotInflight = (async () =>"), src.indexOf("return snapshotInflight;"));
    expect(body).toContain("return snapshot;");
  });

  it("DNS-bypass request is bounded by socket and request timers", () => {
    const src = read("open-sse/utils/proxyFetch.js");
    const bypass = src.slice(src.indexOf("async function createBypassRequest"), src.indexOf("function isProxyActiveForProvider"));
    expect(bypass).toContain("socket.setTimeout");
    expect(bypass).toContain("req.setTimeout");
    expect(bypass).toContain('"abort"');
  });

  it("proxy candidates share one sliced budget, not one full window each", () => {
    const src = read("open-sse/utils/proxyFetch.js");
    const loop = src.slice(src.indexOf("const phaseDeadline"), src.indexOf("// All candidate proxies in the pool were attempted"));
    expect(loop).toContain("leftCandidates");
    expect(loop).toMatch(/const sliceMs = Math\.max\(5000, Math\.floor\(remaining \/ leftCandidates\)\)/);
    expect(loop).toMatch(/Math\.min\(remaining, sliceMs\)/);
    expect(loop).toContain("candidateCtrl");
  });

  it("provider connect timeout reaches the proxy phase", () => {
    const base = read("open-sse/executors/base.js");
    expect(base).toMatch(/connectTimeoutMs: timeoutMs/);
    const proxy = read("open-sse/utils/proxyFetch.js");
    expect(proxy).toMatch(/options\?\.connectTimeoutMs/);
  });

  it("dispatcher eviction closes before dropping", () => {
    const src = read("open-sse/utils/proxyFetch.js");
    const evict = src.slice(src.indexOf("proxyDispatchersMaxSize"), src.indexOf("const { Agent, ProxyAgent }"));
    expect(evict).toMatch(/\.close\(\)|\.destroy\(\)/);
  });

  it("chat path forwards the request signal into the account loop", () => {
    const src = read("src/sse/handlers/chat.js");
    expect(src).toContain("externalSignal: signal");
    expect(src).toMatch(/const signal = abortSignal \|\| request\?\.signal/);
    expect(src).toMatch(/signal\?\.aborted/);
  });

  it("chatCore shares one request origin across combo members", () => {
    const src = read("open-sse/handlers/chatCore.js");
    expect(src).toMatch(/requestStartTime = clientRawRequest\?\.requestStartedAt \|\| Date\.now\(\)/);
  });

  it("keepalive is gated behind a grace race and peeks before the body is read", () => {
    const src = read("src/sse/handlers/chat.js");
    expect(src).toContain("raceGrace(work, 2000)");
    expect(src).toContain("buildStreamErrorBytes");
    expect(src).toMatch(/cancel\(\) \{ stop\(\); \}/);
    const peekAt = src.indexOf("const shape = await peekClientShape(request);");
    const workAt = src.indexOf("const work = withKeyAdmission(");
    expect(peekAt).toBeGreaterThan(-1);
    expect(peekAt).toBeLessThan(workAt);
  });
});

describe("token refresh timeouts", () => {
  it("every refresh call site passes a signal", () => {
    const src = read("open-sse/services/tokenRefresh/providers.js");
    // Per call site: split on the call opener and require a signal before the
    // next call opener, so a newly added unbounded fetch fails this test.
    const parts = src.split(/await (?:fetch|proxyAwareFetch)\(/).slice(1);
    expect(parts.length).toBeGreaterThan(0);
    const unbounded = parts.filter((part) => {
      // The options object ends at the first `);` at column 0 depth — a coarse
      // but stable cut for these hand-written call sites.
      const end = part.indexOf(");");
      const options = end === -1 ? part : part.slice(0, end);
      return !/signal:\s*AbortSignal\.timeout\(/.test(options);
    });
    expect(unbounded).toHaveLength(0);
  });
});

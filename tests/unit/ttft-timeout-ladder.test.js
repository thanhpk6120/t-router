// Locks the per-provider TTFT timeout ladder:
//   docs/resilience/per-provider-timeout-ladder.md
//
// Three layers under test, one section each:
//   A — the pure helpers (no network, no executor)
//   B — the ladder loop inside BaseExecutor.execute() (mock proxyAwareFetch)
//   C — the API trust boundary (normalizeOverride)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the network layer so we can script upstream responses. Only real executor
// fetches are forwarded — recognised by the `connectTimeoutMs` option the executor
// always sets. Other modules touch the proxy layer at import/probe time with a
// different shape, and letting those reach fetchMock corrupts the call list.
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
const {
  effectiveTimeoutLadder,
  normalizeTimeoutLadder,
  ladderToTimeoutsMs,
} = await import("../../open-sse/services/timeoutLadder.js");
const { FETCH_CONNECT_TIMEOUT_MS, TTFT_LADDER_MAX_LEN } = await import(
  "../../open-sse/config/runtimeConfig.js"
);

function res(status) {
  return { status, headers: { get: () => "" } };
}

const creds = { apiKey: "k" };

// Braces matter: `beforeEach(() => fetchMock.mockReset())` returns the mock
// itself, and Vitest treats a hook's return value as a teardown callback — it
// would then invoke fetchMock() with no arguments after every test, running
// whatever implementation the test just installed (hang → 10s hook timeout,
// reject → unhandled rejection, options.signal → TypeError).
beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// A — pure helpers
// ---------------------------------------------------------------------------
describe("effectiveTimeoutLadder — config off", () => {
  it("A1 returns null for a null override", () => {
    expect(effectiveTimeoutLadder(null)).toBe(null);
  });

  it("A2 returns null for an override carrying only headers", () => {
    expect(effectiveTimeoutLadder({ headers: { "X-A": "1" } })).toBe(null);
  });

  it("A3 returns null for an empty array (feature off)", () => {
    expect(effectiveTimeoutLadder({ timeoutLadder: [] })).toBe(null);
  });

  it("A4/A5 return null for undefined and JSON null", () => {
    expect(effectiveTimeoutLadder({ timeoutLadder: undefined })).toBe(null);
    expect(effectiveTimeoutLadder({ timeoutLadder: null })).toBe(null);
  });
});

describe("effectiveTimeoutLadder — accepted shapes", () => {
  it("A6 keeps a single rung", () => {
    expect(effectiveTimeoutLadder({ timeoutLadder: [5] })).toEqual([5]);
  });

  it("A7 clamps a rung above the 60s cap", () => {
    expect(effectiveTimeoutLadder({ timeoutLadder: [5, 10, 30, 60, 90] })).toEqual([5, 10, 30, 60, 60]);
  });

  it("A8/A9 preserves order — the ladder need not increase", () => {
    expect(effectiveTimeoutLadder({ timeoutLadder: [5, 5, 3, 10, 20] })).toEqual([5, 5, 3, 10, 20]);
    expect(effectiveTimeoutLadder({ timeoutLadder: [5, 30, 10] })).toEqual([5, 30, 10]);
  });

  it("A10/A11 truncates past the step cap", () => {
    const out = effectiveTimeoutLadder({ timeoutLadder: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    expect(out).toHaveLength(TTFT_LADDER_MAX_LEN);
    expect(out).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("A18 ignores sibling fields", () => {
    expect(effectiveTimeoutLadder({ headers: { "X-A": "1" }, timeoutLadder: [5, 10] })).toEqual([5, 10]);
  });
});

describe("effectiveTimeoutLadder — rejected shapes", () => {
  // Rejecting the whole array beats silently dropping a rung: a partly-honoured
  // ladder would give the operator fewer attempts than configured.
  const bad = [
    ["A12", [0]],
    ["A13", [-5]],
    ["A14", ["5"]],
    ["A15", [Number.NaN]],
    ["A16", "5,10"],
    ["A17", { 0: 5, 1: 10, length: 2 }],
    ["A19", [5.5]],
  ];

  for (const [id, value] of bad) {
    it(`${id} rejects ${JSON.stringify(value)}`, () => {
      expect(effectiveTimeoutLadder({ timeoutLadder: value })).toBe(null);
    });
  }

  it("rejects an array whose later rung is invalid, not just the bad rung", () => {
    expect(effectiveTimeoutLadder({ timeoutLadder: [5, "10"] })).toBe(null);
  });

  it("A20 a retry delay does not affect the ladder array", () => {
    expect(effectiveTimeoutLadder({ timeoutLadder: [5, 10], timeoutRetryDelayMs: 0 })).toEqual([5, 10]);
  });

  it("warns once when the stored value is corrupt", () => {
    const warn = vi.fn();
    effectiveTimeoutLadder({ timeoutLadder: [0] }, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("ladderToTimeoutsMs", () => {
  it("converts seconds to ms and caps each rung", () => {
    expect(ladderToTimeoutsMs([5, 90])).toEqual([5000, 60000]);
  });

  it("returns an empty array for a disabled ladder", () => {
    expect(ladderToTimeoutsMs(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B — the ladder loop in BaseExecutor.execute()
// ---------------------------------------------------------------------------
// Each helper scripts a fetch that never resolves for headers; the connect timer
// is what ends the attempt, so fake timers drive the whole ladder. Defensive on
// the options object: anything that reaches this point without a signal simply
// never settles.
function hangUntilAborted(_url, options) {
  const abortSignal = options?.signal;
  return new Promise((_resolve, reject) => {
    if (!abortSignal) return;
    abortSignal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });
}

async function runWithFakeTimers(exec, overrides, { advanceMs = 0 } = {}) {
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
  if (advanceMs > 0) await vi.advanceTimersByTimeAsync(advanceMs);
  return { settled, promise: p };
}

describe("BaseExecutor.execute — ladder off keeps today's behaviour", () => {
  it("B1 calls fetch exactly once with the single connect budget", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockImplementation(hangUntilAborted);

    const { settled } = await runWithFakeTimers(exec, null);
    await vi.advanceTimersByTimeAsync(FETCH_CONNECT_TIMEOUT_MS + 10);
    const out = await settled;

    expect(out.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The single attempt must be sized from FETCH_CONNECT_TIMEOUT_MS, not a rung.
    expect(fetchMock.mock.calls[0][1].connectTimeoutMs).toBe(FETCH_CONNECT_TIMEOUT_MS);
  });
});

describe("BaseExecutor.execute — ladder walks the rungs", () => {
  it("B2 a one-rung ladder makes exactly one attempt then fails", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockImplementation(hangUntilAborted);

    const { settled } = await runWithFakeTimers(exec, { timeoutLadder: [5] });
    await vi.advanceTimersByTimeAsync(5000 + 50);
    const out = await settled;

    expect(out.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].connectTimeoutMs).toBe(5000);
  });

  it("B3 three hung rungs produce three attempts, each with its own budget", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockImplementation(hangUntilAborted);

    const { settled } = await runWithFakeTimers(exec, { timeoutLadder: [5, 10, 30] });
    await vi.advanceTimersByTimeAsync(5000 + 250 + 10000 + 250 + 30000 + 100);
    const out = await settled;

    expect(out.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((c) => c[1].connectTimeoutMs)).toEqual([5000, 10000, 30000]);
  });

  it("B4 a rung that succeeds stops the ladder", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    let call = 0;
    fetchMock.mockImplementation((url, options) => {
      call++;
      if (call === 2) return Promise.resolve(res(200));
      return hangUntilAborted(url, options);
    });

    const { settled } = await runWithFakeTimers(exec, { timeoutLadder: [5, 10, 30] });
    await vi.advanceTimersByTimeAsync(5000 + 250 + 100);
    const out = await settled;

    expect(out.ok).toBe(true);
    expect(out.v.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("B11/B12 retries force a fresh socket and carry the current rung's budget", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockImplementation(hangUntilAborted);

    const { settled } = await runWithFakeTimers(exec, { timeoutLadder: [5, 10] });
    await vi.advanceTimersByTimeAsync(5000 + 250 + 10000 + 100);
    await settled;

    // First attempt uses the caller's proxy options untouched; the retry must not
    // reuse the keep-alive socket that just timed out.
    const proxyArgs = fetchMock.mock.calls.map((c) => c[2]);
    expect(proxyArgs[0]?.forceFreshSocket).toBeUndefined();
    expect(proxyArgs[1]?.forceFreshSocket).toBe(true);
    expect(fetchMock.mock.calls.map((c) => c[1].connectTimeoutMs)).toEqual([5000, 10000]);
  });

  it("B7 the ladder restarts per fallback URL", async () => {
    const exec = new BaseExecutor("test", { baseUrls: ["https://a/api", "https://b/api"] });
    fetchMock.mockImplementation(hangUntilAborted);

    const { settled } = await runWithFakeTimers(exec, { timeoutLadder: [5, 10] });
    await vi.advanceTimersByTimeAsync((5000 + 250 + 10000 + 250) * 2 + 200);
    const out = await settled;

    expect(out.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const budgets = fetchMock.mock.calls.map((c) => c[1].connectTimeoutMs);
    expect(budgets).toEqual([5000, 10000, 5000, 10000]);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://a/api",
      "https://a/api",
      "https://b/api",
      "https://b/api",
    ]);
  });

  it("B8 headers arriving means the ladder stops and the body is untouched", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res(200));

    const { settled } = await runWithFakeTimers(exec, { timeoutLadder: [5, 10, 30] });
    await vi.advanceTimersByTimeAsync(10);
    const out = await settled;

    expect(out.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("B14 clears its connect timer once headers arrive", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res(200));

    const { settled } = await runWithFakeTimers(exec, { timeoutLadder: [3, 5, 10] });
    await vi.advanceTimersByTimeAsync(10);
    await settled;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("B15 a non-abort network error is never treated as a ladder rung", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api", retry: { 502: { attempts: 0, delayMs: 0 } } });
    // Lazy rejection: mockRejectedValue would create the rejected promise at
    // setup time, which surfaces as an unhandled rejection before the executor
    // ever awaits it.
    fetchMock.mockImplementation(() =>
      Promise.reject(Object.assign(new Error("ECONNREFUSED"), { name: "TypeError" })),
    );

    const { settled } = await runWithFakeTimers(exec, { timeoutLadder: [5, 10, 30] });
    await vi.advanceTimersByTimeAsync(100);
    const out = await settled;

    expect(out.ok).toBe(false);
    // One attempt only: a refused connection has nothing to wait longer for.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("B16 a client abort propagates instead of walking the ladder", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    const clientCtrl = new AbortController();
    fetchMock.mockImplementation((_url, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });

    vi.useFakeTimers();
    const p = exec.execute({
      model: "m",
      body: {},
      stream: true,
      credentials: creds,
      signal: clientCtrl.signal,
      log: { debug: vi.fn(), warn: vi.fn() },
      providerOverrides: { timeoutLadder: [30, 30] },
    });
    const settled = p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

    clientCtrl.abort();
    await vi.advanceTimersByTimeAsync(50);
    const out = await settled;

    expect(out.ok).toBe(false);
    expect(out.e.name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("B5 status-based retry still owns HTTP errors, not the ladder", async () => {
    const exec = new BaseExecutor("test", {
      baseUrl: "https://x/api",
      retry: { 502: { attempts: 2, delayMs: 0 } },
    });
    fetchMock.mockResolvedValue(res(502));

    vi.useFakeTimers();
    const p = exec.execute({
      model: "m",
      body: {},
      stream: true,
      credentials: creds,
      signal: null,
      log: { debug: vi.fn(), warn: vi.fn() },
      providerOverrides: { timeoutLadder: [5, 10, 30] },
    });
    const settled = p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
    await vi.advanceTimersByTimeAsync(50);

    // attempts: 2 means the first call plus two retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Every call got the FIRST rung, because a 502 response returns before the
    // timer fires — the ladder never advances on a status error.
    expect(fetchMock.mock.calls.map((c) => c[1].connectTimeoutMs)).toEqual([5000, 5000, 5000]);
    await settled;
  });

  it("walks the full ladder when fetch rejects with signal.reason Error (real undici behavior)", async () => {
    const exec = new BaseExecutor("test", { baseUrl: "https://x/api" });
    let calls = 0;
    fetchMock.mockImplementation((_url, options) => {
      calls++;
      if (calls === 5) return Promise.resolve(res(200));
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          // Node/undici rejects with the plain Error passed to connectCtrl.abort(new Error(...)).
          reject(options.signal.reason || new Error("fetch connect timeout"));
        });
      });
    });

    const { settled } = await runWithFakeTimers(exec, { timeoutLadder: [5, 8, 10, 12, 15] });
    await vi.advanceTimersByTimeAsync((5000 + 250) + (8000 + 250) + (10000 + 250) + (12000 + 250) + 100);
    const out = await settled;

    expect(out.ok).toBe(true);
    expect(calls).toBe(5);
    expect(fetchMock.mock.calls.map((c) => c[1].connectTimeoutMs)).toEqual([5000, 8000, 10000, 12000, 15000]);
  });
});

// ---------------------------------------------------------------------------
// C — API trust boundary
// ---------------------------------------------------------------------------
// normalizeOverride is exported from the route so this section does not need the
// Next.js runtime; process.env.PATH is not needed either.
const { normalizeOverride } = await import(
  "../../src/lib/providerOverrides.js"
);

describe("normalizeOverride — headers regression", () => {
  it("C1 still normalizes a header map", () => {
    expect(normalizeOverride({ headers: { "X-A": "1" } })).toEqual({ override: { headers: { "X-A": "1" } } });
  });

  it("C13 headers survive an explicit null ladder", () => {
    expect(normalizeOverride({ headers: { "X-A": "1" }, timeoutLadder: null })).toEqual({
      override: { headers: { "X-A": "1" } },
    });
  });
});

describe("normalizeOverride — ladder", () => {
  it("C2 accepts a valid ladder", () => {
    expect(normalizeOverride({ timeoutLadder: [5, 10] })).toEqual({ override: { timeoutLadder: [5, 10] } });
  });

  it("C8 an empty ladder deletes the field", () => {
    expect(normalizeOverride({ timeoutLadder: [] })).toEqual({ override: null });
  });

  it("C9 headers and ladder are stored together", () => {
    expect(normalizeOverride({ headers: { "X-A": "1" }, timeoutLadder: [5] })).toEqual({
      override: { headers: { "X-A": "1" }, timeoutLadder: [5] },
    });
  });

  it("C3/C4/C5 reject zero, negative, and non-numeric steps", () => {
    expect(normalizeOverride({ timeoutLadder: [0] }).error).toBeTruthy();
    expect(normalizeOverride({ timeoutLadder: [-5] }).error).toBeTruthy();
    expect(normalizeOverride({ timeoutLadder: ["a"] }).error).toBeTruthy();
  });

  it("C6 rejects more steps than the cap", () => {
    const error = normalizeOverride({ timeoutLadder: [5, 10, 15, 20, 25, 30, 35] }).error;
    expect(error).toContain("max");
  });

  it("C7 rejects a step above the 60s cap instead of clamping", () => {
    expect(normalizeOverride({ timeoutLadder: [120] }).error).toContain("maximum");
  });

  it("rejects fractional seconds", () => {
    expect(normalizeOverride({ timeoutLadder: [5.5] }).error).toBeTruthy();
  });

  it("rejects a non-array ladder", () => {
    expect(normalizeOverride({ timeoutLadder: "5,10" }).error).toBeTruthy();
  });
});

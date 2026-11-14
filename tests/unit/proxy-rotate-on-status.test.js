// Rotate-on-status policy (429 must advance the pool) and the two-pass retry
// that runs after every proxy has failed.
//
// The bug this locks down: an adapter that owns its transport (`directFetch` +
// `proxyCapable`, e.g. opencode's wreq-js path) used to return after ONE
// attempt, so the first proxy's 429 went straight to the caller and the rest of
// the pool was never tried. These tests drive `proxyAwareFetch` with a fake
// adapter and a fake undici fetch, so both transports are covered.
//
// Every test uses its own ports: `triggerBackgroundRotate` leaves a proxy in the
// module-level `refreshingProxies` set while its (unreachable) rotate link is
// being called, and a proxy in that set is deliberately demoted behind clean
// candidates. Sharing URLs across tests would let one test's pending rotation
// reorder another test's pool.
//
// Run from tests/:
//   bun x vitest run unit/proxy-rotate-on-status.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_PROXY_ROTATE_STATUSES,
  resolveProxyRotateStatuses,
} from "../../open-sse/config/proxyRotateStatuses.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { clearBadRanges, setKnownProxyRange, setProxyRefreshing } from "../../open-sse/utils/proxyRotator.js";

const originalFetch = globalThis.fetch;

function res(status, body = { ok: true }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const used = new Set();
let seq = 0;

/** Three unique, valid ports (20000–59999) for one candidate pool. */
function nextPorts(count) {
  const ports = [];
  while (ports.length < count) {
    const p = 20000 + ((seq++ * 13) % 40000);
    if (used.has(p)) continue;
    used.add(p);
    ports.push(p);
  }
  return ports;
}

/**
 * Three candidates in the operator's mixed order: rotating first, static last.
 * Ports are unique per call so no test inherits another test's refresh state.
 */
function pool() {
  const [a, b, c] = nextPorts(3);
  return [
    { proxyUrl: `http://127.0.0.1:${a}`, id: `rot-a-${a}`, rotateLink: `http://rot.invalid/a-${a}` },
    { proxyUrl: `http://127.0.0.1:${b}`, id: `rot-b-${b}`, rotateLink: `http://rot.invalid/b-${b}` },
    { proxyUrl: `http://127.0.0.1:${c}`, id: `static-c-${c}`, rotateLink: "" },
  ];
}

/** Two static candidates (nothing can rotate → no second pass is possible). */
function staticPool() {
  const [a, b] = nextPorts(2);
  return [
    { proxyUrl: `http://127.0.0.1:${a}`, id: `s1-${a}`, rotateLink: "" },
    { proxyUrl: `http://127.0.0.1:${b}`, id: `s2-${b}`, rotateLink: "" },
  ];
}

beforeEach(() => {
  clearBadRanges();
  globalThis.fetch = originalFetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  // Let the fire-and-forget rotations settle, then clear the refreshing flags
  // they set, so the next test starts from a clean pool ordering.
  await new Promise((r) => setTimeout(r, 0));
});

describe("resolveProxyRotateStatuses", () => {
  it("defaults to the exits-spent statuses and never to an empty list", () => {
    expect(DEFAULT_PROXY_ROTATE_STATUSES).toEqual([429, 403, 502, 503]);
    expect(resolveProxyRotateStatuses(undefined)).toEqual(DEFAULT_PROXY_ROTATE_STATUSES);
    expect(resolveProxyRotateStatuses(null)).toEqual(DEFAULT_PROXY_ROTATE_STATUSES);
    expect(resolveProxyRotateStatuses([])).toEqual(DEFAULT_PROXY_ROTATE_STATUSES);
    expect(resolveProxyRotateStatuses("")).toEqual(DEFAULT_PROXY_ROTATE_STATUSES);
  });

  it("parses an array and a comma-separated string identically", () => {
    expect(resolveProxyRotateStatuses([429, 503])).toEqual([429, 503]);
    expect(resolveProxyRotateStatuses("429,503")).toEqual([429, 503]);
    expect(resolveProxyRotateStatuses("429 503")).toEqual([429, 503]);
    expect(resolveProxyRotateStatuses("429;503")).toEqual([429, 503]);
    expect(resolveProxyRotateStatuses(["429", " 503 "])).toEqual([429, 503]);
  });

  it("de-duplicates, ignores non-HTTP numbers, and keeps 3-digit codes", () => {
    expect(resolveProxyRotateStatuses([429, 429, 403])).toEqual([429, 403]);
    expect(resolveProxyRotateStatuses([99, 600, 0, -1, 429])).toEqual([429]);
    // "x503" is not a number: Number("x503") is NaN, so it is dropped rather
    // than silently salvaged as 503 — a typo'd rung must not become a live one.
    expect(resolveProxyRotateStatuses("abc,429,x503")).toEqual([429]);
    // Nothing usable left → default, never "rotate on nothing".
    expect(resolveProxyRotateStatuses(["abc", 999])).toEqual(DEFAULT_PROXY_ROTATE_STATUSES);
  });

  it("allows an operator to add a status the default excludes", () => {
    // 400 is a malformed request, not a spent exit — but if the operator says
    // rotate, the engine must honour it verbatim.
    expect(resolveProxyRotateStatuses("400,429")).toEqual([400, 429]);
  });
});

describe("proxyAwareFetch rotates on a configured status", () => {
  it("advances to the next proxy on 429 and returns that proxy's success", async () => {
    const p = pool();
    const tried = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      tried.push(opts?._proxyUrl || "");
      if (tried.length === 1) return res(429, { error: "rate limited" });
      return res(200, { from: "second" });
    });

    const r = await proxyAwareFetch(
      "https://api.example.com/v1/chat",
      { method: "POST" },
      { proxyIntended: true, directActive: false, candidateProxies: p },
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ from: "second" });
    expect(tried.length).toBe(2);
    expect(tried[0]).toContain(p[0].proxyUrl.split(":").pop());
    expect(tried[1]).toContain(p[1].proxyUrl.split(":").pop());
  });

  it("rotates on a custom status set and ignores one not in it", async () => {
    const tried = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      tried.push(opts?._proxyUrl || "");
      if (tried.length === 1) return res(418, { error: "teapot" });
      return res(200, { from: "second" });
    });

    // 418 not configured → the first response is returned as-is.
    const kept = await proxyAwareFetch(
      "https://api.example.com/v1/chat",
      { method: "POST" },
      { proxyIntended: true, directActive: false, candidateProxies: pool(), proxyRotateStatuses: [429] },
    );
    expect(kept.status).toBe(418);
    expect(tried.length).toBe(1);

    tried.length = 0;
    // 418 configured → rotation happens.
    const rotated = await proxyAwareFetch(
      "https://api.example.com/v1/chat",
      { method: "POST" },
      { proxyIntended: true, directActive: false, candidateProxies: pool(), proxyRotateStatuses: "418" },
    );
    expect(rotated.status).toBe(200);
    expect(tried.length).toBe(2);
  });

  it("does NOT rotate on a 400 even when the pool would allow it", async () => {
    const tried = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      tried.push(opts?._proxyUrl || "");
      return res(400, { error: "bad request" });
    });

    const r = await proxyAwareFetch(
      "https://api.example.com/v1/chat",
      { method: "POST" },
      { proxyIntended: true, directActive: false, candidateProxies: pool() },
    );
    expect(r.status).toBe(400);
    expect(tried.length).toBe(1);
  });
});

describe("proxyAwareFetch second pass", () => {
  it("retries the rotated proxies once more, then returns the success", async () => {
    const p = pool();
    const staticUrl = p[2].proxyUrl;
    let rotBCalls = 0;
    const tried = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      const via = opts?._proxyUrl || "";
      tried.push(via);
      if (via === staticUrl) return res(429); // static: exit never changes
      if (via === p[1].proxyUrl) {
        rotBCalls++;
        return rotBCalls === 1 ? res(429) : res(200, { from: "rot-b-second-pass" });
      }
      return res(429); // rot-a: always 429
    });

    const r = await proxyAwareFetch(
      "https://api.example.com/v1/chat",
      { method: "POST" },
      { proxyIntended: true, directActive: false, candidateProxies: p },
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ from: "rot-b-second-pass" });
    // 3 candidates in pass 1, then rot-a + rot-b in pass 2 → the static proxy
    // is NOT retried, because its exit never changed.
    expect(tried.length).toBe(5);
    expect(tried.filter((u) => u === staticUrl).length).toBe(1);
    expect(rotBCalls).toBe(2);
  });

  it("reports the last error only after both passes fail", async () => {
    const tried = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      tried.push(opts?._proxyUrl || "");
      return res(429, { error: "rate limited" });
    });

    // directActive is false and strictProxy is not set: the pool failed twice,
    // so the request is refused rather than leaking the real IP. The reason the
    // caller receives is the LAST status, not an intermediate one.
    await expect(
      proxyAwareFetch(
        "https://api.example.com/v1/chat",
        { method: "POST" },
        { proxyIntended: true, directActive: false, candidateProxies: pool() },
      ),
    ).rejects.toThrow(/HTTP 429/);

    // 3 first-pass + 2 second-pass (rotating only)
    expect(tried.length).toBe(5);
  });

  it("throws when strict proxy is set and every pass fails", async () => {
    globalThis.fetch = vi.fn(async () => res(429));

    await expect(
      proxyAwareFetch(
        "https://api.example.com/v1/chat",
        { method: "POST" },
        { proxyIntended: true, strictProxy: true, candidateProxies: pool() },
      ),
    ).rejects.toThrow(/All 3 proxies failed/);
  });

  it("skips the second pass entirely when no candidate can rotate", async () => {
    const tried = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      tried.push(opts?._proxyUrl || "");
      return res(429);
    });

    await expect(
      proxyAwareFetch(
        "https://api.example.com/v1/chat",
        { method: "POST" },
        { proxyIntended: true, directActive: false, candidateProxies: staticPool() },
      ),
    ).rejects.toThrow(/Refusing direct fallback/);

    // Two static proxies, one pass only: a retry would just re-burn the same
    // timeout for an exit IP that did not change.
    expect(tried.length).toBe(2);
  });
});

describe("proxyAwareFetch adapter path (the original 429 bug)", () => {
  it("drives a transport-owning adapter through every candidate", async () => {
    const p = pool();
    const adapterCalls = [];
    const directFetch = vi.fn(async (url, opts, proxyUrl) => {
      adapterCalls.push(proxyUrl);
      if (adapterCalls.length === 1) return res(429, { error: "rate limited" });
      return res(200, { from: "adapter-second" });
    });
    directFetch.proxyCapable = true;

    const r = await proxyAwareFetch(
      "https://api.example.com/v1/chat",
      { method: "POST", directFetch },
      { proxyIntended: true, directActive: false, candidateProxies: p },
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ from: "adapter-second" });
    // Before the fix the adapter was called exactly once with the first proxy.
    expect(adapterCalls.length).toBe(2);
    expect(adapterCalls[0]).toBe(p[0].proxyUrl);
    expect(adapterCalls[1]).toBe(p[1].proxyUrl);
  });

  it("gives the adapter a second pass over the rotated proxies", async () => {
    const p = pool();
    let rotBCalls = 0;
    const adapterCalls = [];
    const directFetch = vi.fn(async (url, opts, proxyUrl) => {
      adapterCalls.push(proxyUrl);
      if (proxyUrl === p[1].proxyUrl) {
        rotBCalls++;
        return rotBCalls === 1 ? res(429) : res(200, { from: "adapter-pass2" });
      }
      return res(429);
    });
    directFetch.proxyCapable = true;

    const r = await proxyAwareFetch(
      "https://api.example.com/v1/chat",
      { method: "POST", directFetch },
      { proxyIntended: true, directActive: false, candidateProxies: p },
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ from: "adapter-pass2" });
    expect(adapterCalls.length).toBe(5);
  });
});

describe("rotation pool ordering survives the fetch layer", () => {
  it("tries the rotating proxies before the static one (proxySource both)", async () => {
    const p = pool();
    const tried = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      tried.push(opts?._proxyUrl || "");
      if (tried.length < 3) return res(429);
      return res(200);
    });

    await proxyAwareFetch(
      "https://api.example.com/v1/chat",
      { method: "POST" },
      { proxyIntended: true, directActive: false, candidateProxies: p },
    );

    // Both rotating proxies are attempted before the static candidate.
    expect(tried[0]).toBe(p[0].proxyUrl);
    expect(tried[1]).toBe(p[1].proxyUrl);
    expect(tried[2]).toBe(p[2].proxyUrl);
  });

  it("still demotes a known-bad exit below clean candidates", async () => {
    const p = pool();
    setKnownProxyRange(p[0].proxyUrl, "113.161.45.0/24");
    const { markBadRange } = await import("../../open-sse/utils/proxyRotator.js");
    markBadRange("113.161.45.0/24");

    const tried = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      tried.push(opts?._proxyUrl || "");
      return res(200);
    });

    await proxyAwareFetch(
      "https://api.example.com/v1/chat",
      { method: "POST" },
      { proxyIntended: true, directActive: false, candidateProxies: p },
    );

    expect(tried[0]).toBe(p[1].proxyUrl);
    setProxyRefreshing(p[0].proxyUrl, false);
  });

  it("stops immediately without rotating or falling back when outer signal aborts", async () => {
    const p = pool();
    const ctrl = new AbortController();
    const tried = [];
    globalThis.fetch = vi.fn((_url, opts) => {
      tried.push(opts?._proxyUrl || "direct");
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          reject(opts.signal.reason || new Error("aborted"));
        });
      });
    });

    const pending = proxyAwareFetch(
      "https://api.example.com/v1/chat",
      { method: "POST", signal: ctrl.signal, connectTimeoutMs: 5000 },
      { proxyIntended: true, directActive: true, candidateProxies: p },
    );
    setTimeout(() => ctrl.abort(new Error("fetch connect timeout")), 10);

    await expect(pending).rejects.toThrow(/aborted|fetch connect timeout/);
    expect(tried).toEqual([p[0].proxyUrl]);
  });
});

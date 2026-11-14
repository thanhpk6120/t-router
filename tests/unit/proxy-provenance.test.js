import { describe, it, expect, vi } from "vitest";
import {
  tagProxyUsed,
  getResponseProxyInfo,
  tagProxyFailure,
  getProxyFailureInfo,
} from "open-sse/utils/proxyProvenance.js";

/**
 * Per-request proxy provenance.
 *
 * The contract that matters: a request that never passed through the tagging
 * layer must read `null` (unknown), NOT `{proxied: false}` (direct). The UI
 * omits the field in the first case and stays silent; inventing "direct" would
 * turn a guess into a displayed fact, and the whole point of the feature is
 * telling the operator the truth about where their bytes went.
 */

describe("proxyProvenance", () => {
  it("returns null for a response that was never tagged", () => {
    expect(getResponseProxyInfo(new Response("x"))).toBeNull();
  });

  it("returns null for non-object inputs", () => {
    expect(getResponseProxyInfo(null)).toBeNull();
    expect(getResponseProxyInfo(undefined)).toBeNull();
    // Plain object = never went through the tagging layer ⇒ unknown, not direct.
    expect(getResponseProxyInfo({})).toBeNull();
  });

  it("round-trips a proxied descriptor", () => {
    const res = new Response("x");
    tagProxyUsed(res, {
      proxied: true,
      poolId: "xoay1",
      poolName: "xoay1",
      host: "http://10.0.0.1:8080",
      type: "http",
      attempts: 2,
    });
    const info = getResponseProxyInfo(res);
    expect(info.proxied).toBe(true);
    expect(info.poolId).toBe("xoay1");
    expect(info.attempts).toBe(2);
  });

  it("normalizes a non-proxied tag but keeps the reason", () => {
    const res = new Response("x");
    tagProxyUsed(res, { proxied: false, fallbackDirect: true, reason: "ECONNREFUSED" });
    const info = getResponseProxyInfo(res);
    expect(info.proxied).toBe(false);
    expect(info.fallbackDirect).toBe(true);
    expect(info.reason).toBe("ECONNREFUSED");
  });

  it("treats a missing proxied flag as direct, never as proxied", () => {
    const res = new Response("x");
    tagProxyUsed(res, { poolId: "xoay1" });
    expect(getResponseProxyInfo(res).proxied).toBe(false);
  });

  it("survives a clone being handed to a different reader", () => {
    const res = new Response("x");
    tagProxyUsed(res, { proxied: true, poolId: "px1" });
    // Executors wrap the response; the own-property copy is what survives.
    const wrapped = Object.create(res);
    expect(getResponseProxyInfo(wrapped)?.poolId).toBe("px1");
  });

  it("returns the response so it can be used inline", () => {
    const res = new Response("x");
    expect(tagProxyUsed(res, { proxied: true })).toBe(res);
  });

  it("is immune to a test that mocks proxyFetch with only proxyAwareFetch", async () => {
    // The reason this module exists as a separate file. Dozens of suites replace
    // proxyFetch with a bare stub; if the recorder imported through it, every one
    // of those would break on a missing export.
    vi.doMock("open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: vi.fn(async () => new Response("ok")),
    }));
    const fresh = await import("open-sse/utils/proxyProvenance.js?isolated");
    const res = new Response("x");
    fresh.tagProxyUsed(res, { proxied: true, poolId: "px1" });
    expect(fresh.getResponseProxyInfo(res).poolId).toBe("px1");
    vi.doUnmock("open-sse/utils/proxyFetch.js");
  });
});

describe("proxy failure provenance", () => {
  it("reports null for an untagged error so the UI omits the field", () => {
    expect(getProxyFailureInfo(new Error("boom"))).toBeNull();
    expect(getProxyFailureInfo(null)).toBeNull();
  });

  it("records a strict-mode block", () => {
    const err = tagProxyFailure(new Error("strict"), {
      strictProxy: true,
      candidateCount: 3,
      reason: "ECONNREFUSED",
    });
    const info = getProxyFailureInfo(err);
    expect(info.proxied).toBe(false);
    expect(info.strictProxy).toBe(true);
    expect(info.candidateCount).toBe(3);
    expect(info.reason).toBe("ECONNREFUSED");
  });

  it("records a direct-disabled block", () => {
    const err = tagProxyFailure(new Error("leak"), { directDisabled: true });
    expect(getProxyFailureInfo(err).directDisabled).toBe(true);
  });

  it("defaults to non-proxied even if the caller forgets to say so", () => {
    const err = tagProxyFailure(new Error("x"), { reason: "r" });
    expect(getProxyFailureInfo(err).proxied).toBe(false);
  });

  it("returns the error itself so it can be thrown inline", () => {
    const err = new Error("x");
    expect(tagProxyFailure(err, { strictProxy: true })).toBe(err);
  });

  it("does not confuse a Response and an Error", () => {
    const res = new Response("x");
    tagProxyUsed(res, { proxied: true, poolId: "xoay1" });
    expect(getProxyFailureInfo(res).poolId).toBe("xoay1");
    expect(getResponseProxyInfo(new Error("y"))).toBeNull();
  });
});

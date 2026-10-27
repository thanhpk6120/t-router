import { describe, it, expect, vi, beforeEach } from "vitest";
import { exitRange, markBadRange, isBadRange, getBadRanges, clearBadRanges } from "../../open-sse/utils/proxyRotator.js";
vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
  getProxyPools: vi.fn(async () => []),
  isDirectProxyActive: vi.fn(async () => false),
}));

import { resolveRotationPoolIds } from "../../src/lib/network/connectionProxy.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

describe("ProxyRotator Subnet & Bad Range Cache", () => {
  beforeEach(() => {
    clearBadRanges();
  });

  it("normalizes IPv4 to /24 subnet", () => {
    expect(exitRange("113.161.45.12")).toBe("113.161.45.0/24");
    expect(exitRange("192.168.1.100")).toBe("192.168.1.0/24");
    expect(exitRange("8.8.8.8")).toBe("8.8.8.0/24");
  });

  it("normalizes IPv6 to /48 subnet", () => {
    expect(exitRange("2402:800:61c3:1234::1")).toBe("2402:800:61c3::/48");
    expect(exitRange("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("2001:0db8:85a3::/48");
  });

  it("stores and queries known-bad exit ranges", () => {
    expect(isBadRange("113.161.45.0/24")).toBe(false);

    markBadRange("113.161.45.0/24");
    expect(isBadRange("113.161.45.0/24")).toBe(true);
    expect(isBadRange("113.161.46.0/24")).toBe(false);

    markBadRange("2402:800:61c3::/48");
    expect(isBadRange("2402:800:61c3::/48")).toBe(true);
    expect(getBadRanges()).toContain("113.161.45.0/24");
    expect(getBadRanges()).toContain("2402:800:61c3::/48");
  });
});

describe("resolveRotationPoolIds RotatingFirst ordering", () => {
  const mixedPools = [
    { id: "static-1", proxyUrl: "http://static-1:8080" },
    { id: "rot-1", proxyUrl: "http://rot-1:8080", rotateLink: "http://api/rotate1" },
    { id: "static-2", proxyUrl: "http://static-2:8080" },
    { id: "rot-2", proxyUrl: "http://rot-2:8080", rotateUrl: "http://api/rotate2" },
  ];

  it("prioritizes rotating proxies first in mixed (both) mode", () => {
    const ids = resolveRotationPoolIds(mixedPools, undefined, "both");
    expect(ids).toEqual(["rot-1", "rot-2", "static-1", "static-2"]);
  });

  it("filters only rotating when proxySource is rotating", () => {
    const ids = resolveRotationPoolIds(mixedPools, undefined, "rotating");
    expect(ids).toEqual(["rot-1", "rot-2"]);
  });

  it("filters only static when proxySource is static", () => {
    const ids = resolveRotationPoolIds(mixedPools, undefined, "static");
    expect(ids).toEqual(["static-1", "static-2"]);
  });
});

describe("proxyAwareFetch Multi-Proxy Fallback", () => {
  it("falls back to next active candidate proxy when first proxy fails", async () => {
    let callCount = 0;
    const attemptedUrls = [];

    // Mock global fetch to fail on proxy 1 and succeed on proxy 2
    const originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, opts) => {
      callCount++;
      const agentUri = opts?.dispatcher?.proxy?.origin || opts?.dispatcher?.uri?.origin;
      attemptedUrls.push(agentUri);

      if (callCount === 1) {
        throw new Error("Proxy connection refused");
      }
      return new Response(JSON.stringify({ ok: true, msg: "success from proxy 2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      const proxyOptions = {
        proxyIntended: true,
        directActive: false, // Direct connection is disabled!
        candidateProxies: [
          { proxyUrl: "http://127.0.0.1:9001", id: "p1", rotateLink: "http://rot1" },
          { proxyUrl: "http://127.0.0.1:9002", id: "p2", rotateLink: "" },
        ],
      };

      const res = await proxyAwareFetch("https://api.example.com/v1/chat", { method: "POST" }, proxyOptions);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.msg).toBe("success from proxy 2");
      expect(callCount).toBe(2);
    } finally {
      globalThis.fetch = originalGlobalFetch;
    }
  });

  it("fails safely without leaking direct IP when all candidate proxies fail and directActive is false", async () => {
    const originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Proxy connection timeout");
    });

    try {
      const proxyOptions = {
        proxyIntended: true,
        directActive: false, // Direct disabled to prevent leak
        candidateProxies: [
          { proxyUrl: "http://127.0.0.1:9001", id: "p1" },
          { proxyUrl: "http://127.0.0.1:9002", id: "p2" },
        ],
      };

      await expect(
        proxyAwareFetch("https://api.example.com/v1/chat", { method: "POST" }, proxyOptions)
      ).rejects.toThrow(/Refusing direct fallback to prevent IP leak/);
    } finally {
      globalThis.fetch = originalGlobalFetch;
    }
  });
});

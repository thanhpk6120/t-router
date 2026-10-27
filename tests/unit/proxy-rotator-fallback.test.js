import { describe, it, expect, vi, beforeEach } from "vitest";
import { exitRange, markBadRange, isBadRange, getBadRanges, clearBadRanges, setKnownProxyRange, setProxyRefreshing } from "../../open-sse/utils/proxyRotator.js";

const mockGetProxyPools = vi.fn(async () => []);
const mockGetProxyPoolById = vi.fn();
const mockIsDirectProxyActive = vi.fn(async () => false);

vi.mock("@/models", () => ({
  getProxyPoolById: (...args) => mockGetProxyPoolById(...args),
  getProxyPools: (...args) => mockGetProxyPools(...args),
  isDirectProxyActive: (...args) => mockIsDirectProxyActive(...args),
}));

import { resolveRotationPoolIds, resolveConnectionProxyConfig, pickProxyPoolId } from "../../src/lib/network/connectionProxy.js";
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

  it("normalizes IPv6 to /48 subnet, correctly expanding compressed :: notation", () => {
    expect(exitRange("2402:800:61c3:1234::1")).toBe("2402:800:61c3::/48");
    expect(exitRange("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("2001:db8:85a3::/48");
    // Compressed IPv6 address
    expect(exitRange("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(exitRange("::1")).toBe("0:0:0::/48");
    expect(exitRange("fe80::1ff:fe23:4567:890a")).toBe("fe80:0:0::/48");
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

describe("resolveRotationPoolIds & pickProxyPoolId RotatingFirst ordering", () => {
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

  it("pickProxyPoolId picks among rotating proxies first in mixed mode", () => {
    const poolIds = ["rot-1", "rot-2", "static-1", "static-2"];
    const picked = pickProxyPoolId(poolIds, "round-robin", "test-provider", mixedPools);
    expect(["rot-1", "rot-2"]).toContain(picked);
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

describe("resolveConnectionProxyConfig with Direct disabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDirectProxyActive.mockResolvedValue(false);
  });

  it("never includes 'direct' in candidateProxies", async () => {
    const directPool = { id: "direct", name: "Direct Connection", proxyUrl: "direct", isActive: true };
    const realPool = { id: "p1", name: "Proxy 1", proxyUrl: "http://1.1.1.1:8080", isActive: true };
    mockGetProxyPoolById.mockResolvedValue(directPool);
    mockGetProxyPools.mockResolvedValue([directPool, realPool]);

    const res = await resolveConnectionProxyConfig({ proxyPoolId: "direct" });
    expect(res.candidateProxies).not.toBeNull();
    for (const c of res.candidateProxies) {
      expect(c.id).not.toBe("direct");
      expect(c.proxyUrl).not.toBe("direct");
    }
  });

  it("automatically adopts active real proxies when directActive is false and pool was direct or empty", async () => {
    const realRotPool = { id: "rot-p1", name: "Rotating Proxy", proxyUrl: "http://2.2.2.2:8080", rotateLink: "http://rot", isActive: true };
    const realStaticPool = { id: "static-p1", name: "Static Proxy", proxyUrl: "http://3.3.3.3:8080", isActive: true };
    mockGetProxyPools.mockResolvedValue([
      { id: "direct", proxyUrl: "direct", isActive: false },
      realStaticPool,
      realRotPool,
    ]);

    // Request with no proxy configured or direct disabled
    const res = await resolveConnectionProxyConfig({ proxyPoolId: "" });
    expect(res.connectionProxyEnabled).toBe(true);
    // RotatingFirst: rotating proxy must be chosen as primary!
    expect(res.proxyPoolId).toBe("rot-p1");
    expect(res.candidateProxies.map((c) => c.id)).toEqual(["rot-p1", "static-p1"]);
  });
});

describe("proxyAwareFetch Multi-Proxy Fallback & Bad Range avoidance", () => {
  beforeEach(() => {
    clearBadRanges();
  });

  it("falls back to next active candidate proxy when first proxy fails", async () => {
    let callCount = 0;
    const attemptedProxies = [];

    const originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, opts) => {
      callCount++;
      const agentUri = opts?.dispatcher?.proxy?.origin || opts?.dispatcher?.uri?.origin;
      attemptedProxies.push(agentUri);

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

  it("skips proxies with known-bad exit ranges or currently refreshing and prefers clean candidates", async () => {
    const badProxyUrl = "http://127.0.0.1:9001";
    const cleanProxyUrl = "http://127.0.0.1:9002";

    // Mark proxy 1 as having bad exit range
    setKnownProxyRange(badProxyUrl, "113.161.45.0/24");
    markBadRange("113.161.45.0/24");

    let firstTriedProxy = "";
    const originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, opts) => {
      firstTriedProxy = opts?._proxyUrl || opts?.dispatcher?.proxy?.origin || "";
      return new Response(JSON.stringify({ ok: true, msg: "success" }), { status: 200 });
    });

    try {
      const proxyOptions = {
        proxyIntended: true,
        directActive: false,
        candidateProxies: [
          { proxyUrl: badProxyUrl, id: "p1", rotateLink: "http://rot1" },
          { proxyUrl: cleanProxyUrl, id: "p2", rotateLink: "" },
        ],
      };

      const res = await proxyAwareFetch("https://api.example.com/v1/chat", { method: "POST" }, proxyOptions);
      expect(res.status).toBe(200);
      // Clean proxy was sorted first because p1 has a known-bad range
      expect(firstTriedProxy).toContain("9002");
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
        directActive: false,
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

import { describe, it, expect, vi } from "vitest";
import {
  resolveProviderEffectiveProxy,
  resolveConnectionLayerProxy,
  mergeConnectionLayer,
  emptyProxyDescriptor,
  maskProxyHost,
} from "@/lib/network/effectiveProxy.js";

/**
 * The dashboard must never claim a proxy that the request will not use.
 *
 * These cases are pinned to the precedence in `getProviderCredentials`
 * (src/sse/services/auth.js, the no-auth branch). When that function changes,
 * these break — which is the point: a badge that disagrees with the routing is
 * worse than no badge, because the operator reads it as proof.
 */

vi.mock("@/models", () => ({
  getSettings: vi.fn(async () => ({ providerStrategies: {} })),
  getProxyPools: vi.fn(async () => []),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ providerStrategies: {} })),
  getProviderConnectionProxyBindings: vi.fn(async () => new Map()),
}));

const ROTATING = {
  id: "xoay1",
  name: "xoay1",
  proxyUrl: "http://10.0.0.1:8080",
  rotateLink: "http://10.0.0.1:9090/rotate",
  isActive: true,
};
const STATIC_A = { id: "px1", name: "px1", proxyUrl: "http://10.0.0.2:3128", isActive: true };
const STATIC_B = { id: "US", name: "US", proxyUrl: "socks5://10.0.0.3:1080", isActive: true };
const DIRECT = { id: "direct", name: "Direct", proxyUrl: "direct", isActive: true };
const ALL = [DIRECT, ROTATING, STATIC_A, STATIC_B];

describe("resolveProviderEffectiveProxy", () => {
  it("reports nothing when the override is empty", () => {
    expect(resolveProviderEffectiveProxy({}, ALL, "p")).toEqual(emptyProxyDescriptor());
  });

  it("reports nothing when the strategy is set but no pool is usable", () => {
    const onlyDirect = [DIRECT];
    expect(resolveProviderEffectiveProxy({ rotateStrategy: "fallback" }, onlyDirect, "p").proxied)
      .toBe(false);
  });

  it("rotation with 'None (direct)' in the selector is still proxied", () => {
    // The exact misreading this module exists to prevent.
    const d = resolveProviderEffectiveProxy(
      { proxyPoolId: "__none__", rotateStrategy: "fallback" },
      ALL,
      "p",
    );
    expect(d.proxied).toBe(true);
    expect(d.source).toBe("rotation");
    expect(d.strategy).toBe("fallback");
  });

  it("fallback rotation picks the rotating pool first", () => {
    const d = resolveProviderEffectiveProxy({ rotateStrategy: "fallback" }, ALL, "p");
    expect(d.poolId).toBe("xoay1");
    expect(d.poolCount).toBe(3);
    expect(d.rotateLink).toBe(true);
  });

  it("round-robin does not advance the cursor just by being read", () => {
    const first = resolveProviderEffectiveProxy({ rotateStrategy: "round-robin" }, ALL, "p");
    const second = resolveProviderEffectiveProxy({ rotateStrategy: "round-robin" }, ALL, "p");
    const third = resolveProviderEffectiveProxy({ rotateStrategy: "round-robin" }, ALL, "p");
    expect(first.poolId).toBe(third.poolId);
    expect(second.poolId).toBe(third.poolId);
  });

  it("an explicit pool wins over rotation, exactly as auth.js resolves it", () => {
    // auth.js: `let pickedId = override.proxyPoolId; if (!pickedId && strategy...)`
    const d = resolveProviderEffectiveProxy(
      { proxyPoolId: "px1", rotateStrategy: "round-robin" },
      ALL,
      "p",
    );
    expect(d.source).toBe("provider-override");
    expect(d.poolId).toBe("px1");
    expect(d.strategy).toBe("none");
  });

  it("treats 'fill-first' as not-a-rotation", () => {
    const d = resolveProviderEffectiveProxy({ rotateStrategy: "fill-first" }, ALL, "p");
    expect(d.proxied).toBe(false);
  });

  it("honours the proxyPoolIds whitelist", () => {
    const d = resolveProviderEffectiveProxy(
      { rotateStrategy: "fallback", proxyPoolIds: ["US"] },
      ALL,
      "p",
    );
    expect(d.poolId).toBe("US");
    expect(d.poolCount).toBe(1);
  });

  it("ignores the legacy 'direct' pool entry", () => {
    const d = resolveProviderEffectiveProxy({ proxyPoolId: "direct" }, ALL, "p");
    expect(d.proxied).toBe(false);
  });

  it("never leaks proxy credentials", () => {
    const withCreds = [{
      id: "cred",
      name: "cred",
      proxyUrl: "http://user:hunter2@10.0.0.9:8080",
      isActive: true,
    }];
    const d = resolveProviderEffectiveProxy({ proxyPoolId: "cred" }, withCreds, "p");
    expect(d.host).toBe("http://10.0.0.9:8080");
    expect(d.host).not.toContain("hunter2");
  });
});

describe("connection-level pinning", () => {
  const binding = (byPoolEntries, legacy = 0) =>
    ({ active: byPoolEntries.reduce((n, [, c]) => n + c, 0) + legacy, byPool: new Map(byPoolEntries), legacy });

  it("reports the pinned pool when every live connection agrees", () => {
    const d = resolveConnectionLayerProxy(binding([["px1", 4]]), ALL);
    expect(d.source).toBe("connection");
    expect(d.proxied).toBe(true);
    expect(d.poolId).toBe("px1");
    expect(d.host).toBe("http://10.0.0.2:3128");
    expect(d.connectionCount).toBe(4);
  });

  it("overrides a rotation badge — auth.js reads connPoolId first", () => {
    // `if (!connPoolId) { …provider override, then rotation… }` in auth.js:
    // a pinned connection never consults the provider strategy at all.
    const base = resolveProviderEffectiveProxy({ rotateStrategy: "round-robin" }, ALL, "p");
    expect(base.proxied).toBe(true);
    const d = mergeConnectionLayer(base, binding([["US", 2]]), ALL);
    expect(d.source).toBe("connection");
    expect(d.poolId).toBe("US");
    expect(d.strategy).toBe("none");
  });

  it("flags a pin to a pool that is missing or inactive as NOT proxied", () => {
    // resolveConnectionProxyConfig cannot resolve a dead pool and falls through
    // to direct. Traffic leaves on the real IP — the case a badge must expose.
    const d = resolveConnectionLayerProxy(binding([["deleted-pool", 3]]), ALL);
    expect(d.proxied).toBe(false);
    expect(d.poolMissing).toBe(true);
    expect(d.poolName).toBe("deleted-pool");
    expect(d.reason).toContain("missing or inactive");
  });

  it("names a legacy connectionProxyUrl binding", () => {
    const d = resolveConnectionLayerProxy(binding([], 5), ALL);
    expect(d.proxied).toBe(true);
    expect(d.poolName).toBe("legacy proxy");
    expect(d.connectionCount).toBe(5);
  });

  it("says mixed when connections point at different pools", () => {
    const d = resolveConnectionLayerProxy(binding([["px1", 2], ["US", 3]]), ALL);
    expect(d.mixed).toBe(true);
    expect(d.proxied).toBe(true);
    expect(d.poolId).toBeNull();
    expect(d.poolCount).toBe(2);
  });

  it("keeps the provider answer when unbound connections outnumber the pinned ones", () => {
    const base = resolveProviderEffectiveProxy({ rotateStrategy: "fallback" }, ALL, "p");
    const d = mergeConnectionLayer(base, binding([["px1", 1], [null, 9]]), ALL);
    expect(d.source).toBe("rotation");
    expect(d.poolId).toBe("xoay1");
    expect(d.pinnedElsewhere).toBe(true);
    expect(d.pinnedCount).toBe(1);
  });

  it("returns null when nothing is pinned at all", () => {
    expect(resolveConnectionLayerProxy(binding([[null, 7]]), ALL)).toBeNull();
    expect(resolveConnectionLayerProxy({ active: 0, byPool: new Map() }, ALL)).toBeNull();
  });

  it("names every pinned pool when several are live", () => {
    const d = resolveConnectionLayerProxy(binding([["px1", 2], ["US", 3]]), ALL);
    expect(d.poolName).toBe("mixed: px1, US");
  });

  it("says 'or direct' when unbound connections ride alongside pinned ones", () => {
    const d = resolveConnectionLayerProxy(binding([["px1", 2], [null, 4]]), ALL);
    expect(d.unboundCount).toBe(4);
    expect(d.poolName).toBe("px1 or direct");
  });

  it("reports a whole provider of dead pins once, not per connection", () => {
    const d = resolveConnectionLayerProxy(binding([["gone-a", 2], ["gone-b", 3]]), ALL);
    expect(d.proxied).toBe(false);
    expect(d.poolMissing).toBe(true);
    expect(d.reason).toContain("gone-a");
    expect(d.reason).toContain("gone-b");
  });

  it("treats '__none__' as unbound, matching the UI's explicit-unbind marker", () => {
    // getProviderConnectionProxyBindings already normalises this; pin it here so
    // a future query change cannot turn "__none__" into a phantom pool.
    const d = resolveConnectionLayerProxy(binding([[null, 2]]), ALL);
    expect(d).toBeNull();
  });

  it("does not call an explicit Direct pin a missing pool", () => {
    // The connection dropdown writes proxyPoolId="direct" when the operator
    // picks Direct. That is a working configuration, not a broken one — a red
    // "missing" badge here would be the false alarm that teaches the operator
    // to ignore the real one.
    const d = resolveConnectionLayerProxy(binding([["direct", 3]]), ALL);
    expect(d.directByConnection).toBe(true);
    expect(d.poolMissing).toBeUndefined();
    expect(d.proxied).toBe(false);
  });

  it("suppresses a rotation badge when every connection is pinned to Direct", () => {
    // auth.js: `if (!connPoolId)` — "direct" is truthy, so the rotation branch is
    // never reached and the provider-level badge must not claim otherwise.
    const base = resolveProviderEffectiveProxy({ rotateStrategy: "fallback" }, ALL, "p");
    const d = mergeConnectionLayer(base, binding([["direct", 5]]), ALL);
    expect(d.proxied).toBe(false);
    expect(d.source).toBe("none");
  });

  it("counts Direct pins as direct traffic when mixed with a real pool", () => {
    // Half the requests leave on the real IP, so "px1" alone would overstate.
    const d = resolveConnectionLayerProxy(binding([["px1", 2], ["direct", 3]]), ALL);
    expect(d.poolName).toBe("px1 or direct");
    expect(d.unboundCount).toBe(3);
  });
});

describe("maskProxyHost", () => {
  it("drops userinfo and path", () => {
    expect(maskProxyHost("http://u:p@host.tld:8080/path?x=1")).toBe("http://host.tld:8080");
  });

  it("returns empty for direct and blanks", () => {
    expect(maskProxyHost("direct")).toBe("");
    expect(maskProxyHost("")).toBe("");
    expect(maskProxyHost(null)).toBe("");
  });
});

// Effective-proxy descriptor: the dashboard's only source of truth for "is this
// traffic proxied, and through what?".
//
// This is not a rendering test. It locks the precedence chain that auth.js
// actually walks — connection pin → provider override → rotation strategy →
// direct — because a badge that disagrees with auth.js is worse than no badge:
// it tells the operator a request went through a proxy that auth.js never used.
//
// Run from tests/:
//   npx vitest run unit/effective-proxy.test.js
import { describe, it, expect, vi } from "vitest";

// The module pulls its data through the Next alias layer. Tests inject the same
// shapes the real readers return, so the precedence logic is exercised without
// a database.
vi.mock("@/models", () => ({ getProxyPools: vi.fn(async () => []) }));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({})),
  getProviderConnectionProxyBindings: vi.fn(async () => new Map()),
}));

const {
  maskProxyHost,
  emptyProxyDescriptor,
  resolveProviderEffectiveProxy,
  resolveConnectionLayerProxy,
  mergeConnectionLayer,
  resolveProviderEffectiveProxyMap,
} = await import("../../src/lib/network/effectiveProxy.js");

const models = await import("@/models");
const localDb = await import("@/lib/localDb");

const POOLS = [
  { id: "direct", name: "Direct", proxyUrl: "direct" },
  { id: "p-xoay", name: "xoay1", proxyUrl: "http://sp07v6-40632:MMOYD@103.69.188.53:40632", rotateLink: "http://103.199.16.140:25000/sp07v6/40632-HFUFANXYHO" },
  { id: "p-us", name: "US", proxyUrl: "http://u:p@23.26.71.195:5678" },
  { id: "p-px", name: "px1", proxyUrl: "http://user10407:vB5CGFeW@proxy-s6.resident-psun.io.vn:10407" },
];

describe("maskProxyHost", () => {
  it("strips proxy credentials — the dashboard must never hold a password", () => {
    expect(maskProxyHost("http://sp07v6-40632:MMOYD@103.69.188.53:40632")).toBe(
      "http://103.69.188.53:40632",
    );
    expect(maskProxyHost("http://user10407:vB5CGFeW@proxy-s6.resident-psun.io.vn:10407")).toBe(
      "http://proxy-s6.resident-psun.io.vn:10407",
    );
  });

  it("returns empty for direct, blank and missing values", () => {
    expect(maskProxyHost("direct")).toBe("");
    expect(maskProxyHost("")).toBe("");
    expect(maskProxyHost(null)).toBe("");
  });
});

describe("resolveProviderEffectiveProxy — auth.js precedence", () => {
  it("an explicit pool wins over the rotation strategy", () => {
    const d = resolveProviderEffectiveProxy(
      { proxyPoolId: "p-us", rotateStrategy: "round-robin", proxyPoolIds: ["p-xoay", "p-px"] },
      POOLS,
      "prov",
    );
    // auth.js seeds pickedId from proxyPoolId and never computes a rotation pick
    // when it is set. Painting the rotation badge here would be a lie.
    expect(d.proxied).toBe(true);
    expect(d.poolId).toBe("p-us");
    expect(d.source).toBe("provider-override");
    expect(d.strategy).toBe("none");
  });

  it("falls to rotation only when no explicit pool is set", () => {
    const d = resolveProviderEffectiveProxy(
      { rotateStrategy: "round-robin", proxyPoolIds: ["p-xoay", "p-us"] },
      POOLS,
      "prov",
    );
    expect(d.proxied).toBe(true);
    expect(d.source).toBe("rotation");
    expect(d.strategy).toBe("round-robin");
    expect(d.poolCount).toBe(2);
    expect(["p-xoay", "p-us"]).toContain(d.poolId);
  });

  it("treats __none__ as no explicit pool", () => {
    const d = resolveProviderEffectiveProxy({ proxyPoolId: "__none__" }, POOLS, "prov");
    expect(d.proxied).toBe(false);
  });

  it("does not treat fill-first as a proxy rotation", () => {
    // fill-first is the connection-selection strategy leaking into the same
    // field; auth.js excludes it, so the badge must too.
    const d = resolveProviderEffectiveProxy(
      { rotateStrategy: "fill-first", proxyPoolIds: ["p-us"] },
      POOLS,
      "prov",
    );
    expect(d.proxied).toBe(false);
  });

  it("reports no proxy when the pinned pool is missing", () => {
    const d = resolveProviderEffectiveProxy({ proxyPoolId: "gone" }, POOLS, "prov");
    expect(d.proxied).toBe(false);
    expect(d.poolId).toBeNull();
  });

  it("never reports the direct pool as proxied", () => {
    const d = resolveProviderEffectiveProxy({ proxyPoolId: "direct" }, POOLS, "prov");
    expect(d.proxied).toBe(false);
  });

  it("carries rotateLink through so the UI can show 'rotates its own exit'", () => {
    const d = resolveProviderEffectiveProxy({ proxyPoolId: "p-xoay" }, POOLS, "prov");
    expect(d.rotateLink).toBe(true);
    expect(d.host).toBe("http://103.69.188.53:40632");
  });
});

describe("resolveConnectionLayerProxy — connection pin beats provider layer", () => {
  const binding = (active, byPool, legacy = 0) => ({
    active,
    byPool: byPool instanceof Map ? byPool : new Map(Object.entries(byPool)),
    legacy,
  });

  it("a fully pinned provider is decided by its connection", () => {
    const d = resolveConnectionLayerProxy(binding(3, { "p-us": 3 }), POOLS, true);
    expect(d.proxied).toBe(true);
    expect(d.poolId).toBe("p-us");
    expect(d.source).toBe("connection");
    // The provider-level rotation badge is suppressed: auth.js never reaches it.
    expect(d.strategy).toBe("none");
  });

  it("suppresses the badge entirely when every connection is pinned to direct", () => {
    const d = resolveConnectionLayerProxy(binding(2, { direct: 2 }), POOLS, true);
    expect(d.directByConnection).toBe(true);
    expect(d.proxied).toBe(false);
  });

  it("flags poolMissing when the pinned pool is gone — traffic is NOT proxied", () => {
    // The most important thing this badge reports: the operator believes the
    // traffic is proxied while auth.js silently falls through to direct.
    const d = resolveConnectionLayerProxy(binding(2, { "p-deleted": 2 }), POOLS, false);
    expect(d.proxied).toBe(false);
    expect(d.poolMissing).toBe(true);
    expect(d.reason).toContain("missing or inactive");
  });

  it("annotates as partial when unbound connections coexist with pinned ones", () => {
    // Unbound connections are keyed by `null` in byPool — the real shape the
    // grouped SQL read produces. `active: 3` alone is not enough: without a null
    // entry every live connection looks pinned, and the badge would name one pool
    // for traffic that partly leaves direct.
    const d = resolveConnectionLayerProxy(
      binding(3, new Map([["p-us", 1], [null, 2]])),
      POOLS,
      true,
    );
    expect(d.partial).toBe(true);
    expect(d.unboundCount).toBe(2);
    expect(d.pinnedGroups).toHaveLength(1);
    expect(d.pinnedGroups[0].poolId).toBe("p-us");
  });

  it("marks mixed when connections are pinned to different live pools", () => {
    const d = resolveConnectionLayerProxy(binding(2, { "p-us": 1, "p-px": 1 }), POOLS, false);
    expect(d.mixed).toBe(true);
    expect(d.proxied).toBe(true);
    expect(d.poolName).toContain("mixed");
  });

  it("returns null when no live connection is pinned", () => {
    expect(resolveConnectionLayerProxy(binding(0, {}), POOLS, true)).toBeNull();
  });
});

describe("mergeConnectionLayer", () => {
  it("an explicit direct pin erases a provider-level proxy badge", () => {
    const base = { ...emptyProxyDescriptor(), proxied: true, poolId: "p-us", poolName: "US" };
    const binding = { active: 1, byPool: new Map([["direct", 1]]), legacy: 0 };
    expect(mergeConnectionLayer(base, binding, POOLS).proxied).toBe(false);
  });

  it("leaves the provider layer untouched when nothing is pinned", () => {
    const base = { ...emptyProxyDescriptor(), proxied: true, poolId: "p-us" };
    expect(mergeConnectionLayer(base, null, POOLS)).toBe(base);
  });
});

describe("resolveProviderEffectiveProxyMap — one read for the whole grid", () => {
  it("returns only providers that resolve to a proxy, missing pool or mixed", async () => {
    models.getProxyPools.mockResolvedValueOnce(POOLS);
    localDb.getSettings.mockResolvedValueOnce({
      providerStrategies: {
        pinned: { proxyPoolId: "p-us" },
        rotating: { rotateStrategy: "round-robin", proxyPoolIds: ["p-us", "p-px"] },
        none: {},
      },
    });
    localDb.getProviderConnectionProxyBindings.mockResolvedValueOnce(
      new Map([
        ["broken", { active: 1, byPool: new Map([["gone", 1]]), legacy: 0 }],
      ]),
    );

    const map = await resolveProviderEffectiveProxyMap();

    expect(map.pinned.proxied).toBe(true);
    expect(map.rotating.proxied).toBe(true);
    // A provider with no proxy configured is absent, so the UI rule is a key
    // lookup rather than a condition ladder.
    expect(map.none).toBeUndefined();
    // A connection pinned to a dead pool still appears — it is the case the
    // operator most needs to see.
    expect(map.broken.poolMissing).toBe(true);
  });

  it("degrades to an empty map when settings cannot be read", async () => {
    models.getProxyPools.mockResolvedValueOnce([]);
    localDb.getSettings.mockRejectedValueOnce(new Error("db down"));
    expect(await resolveProviderEffectiveProxyMap()).toEqual({});
  });
});

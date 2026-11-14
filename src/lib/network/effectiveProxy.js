import { getProxyPools } from "@/models";
import { getSettings, getProviderConnectionProxyBindings } from "@/lib/localDb";
import {
  peekProxyPoolId,
  resolveRotationPoolIds,
} from "./connectionProxy.js";

/**
 * Effective-proxy descriptor — the dashboard's answer to "is this traffic
 * actually proxied, and through what?".
 *
 * Reading it off the pool selector alone is wrong: rotation overrides the
 * selector, and a provider override overrides the connection. This mirrors the
 * precedence used by `getProviderCredentials`, but non-mutating (peek, not
 * pick) so rendering a page never advances live rotation state, and it never
 * carries proxy credentials — host only, never user:pass.
 *
 * Shape:
 *   {
 *     proxied: boolean,      // false ⇒ direct, the UI must render nothing
 *     poolId: string|null,
 *     poolName: string|null,
 *     host: string,          // scheme://host:port
 *     strategy: "none"|"round-robin"|"random"|"fallback",
 *     source: "rotation"|"provider-override",
 *     rotateLink: boolean,   // pool rotates its own exit IP
 *     poolCount: number,     // pools covered by the rotation
 *   }
 */
export function maskProxyHost(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value || value === "direct") return "";
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return value;
  }
}

export function emptyProxyDescriptor() {
  return {
    proxied: false,
    poolId: null,
    poolName: null,
    host: "",
    strategy: "none",
    source: "none",
    rotateLink: false,
    poolCount: 0,
  };
}
function isUsablePool(pool) {
  return Boolean(
    pool &&
    pool.id !== "direct" &&
    pool.proxyUrl &&
    pool.proxyUrl !== "direct"
  );
}

function descriptorFor(pool, coveredPools, strategy, source) {
  if (!isUsablePool(pool)) return emptyProxyDescriptor();
  return {
    proxied: true,
    poolId: pool.id,
    poolName: pool.name || pool.id,
    host: maskProxyHost(pool.proxyUrl),
    strategy,
    source,
    rotateLink: Boolean(pool.rotateLink || pool.rotateUrl),
    poolCount: Array.isArray(coveredPools) ? coveredPools.length : 1,
  };
}

/**
 * Resolve the proxy a no-auth / free provider will use, from its settings
 * override. Precedence is copied from getProviderCredentials in
 * src/sse/services/auth.js, which is the only place that decides it:
 *
 *   explicit proxyPoolId  →  whitelisted rotation strategy  →  direct
 *
 * Order matters. auth.js seeds `pickedId` from `override.proxyPoolId` and only
 * computes a rotation pick when that is empty (`if (!pickedId && strategy !==
 * "none")`). Reading rotation first would paint a rotating badge over a request
 * that in fact goes to one pinned pool.
 *
 * @param {object} override   settings.providerStrategies[providerId] || {}
 * @param {Array}  allPools   active proxy pools
 * @param {string} providerId rotation cursor key
 */
export function resolveProviderEffectiveProxy(override = {}, allPools = [], providerId = "") {
  const strategy = override.rotateStrategy || "none";
  const explicitPoolId =
    override.proxyPoolId && override.proxyPoolId !== "__none__"
      ? override.proxyPoolId
      : null;

  if (explicitPoolId) {
    const pool = allPools.find((p) => p?.id === explicitPoolId);
    if (isUsablePool(pool)) {
      return descriptorFor(pool, [pool], "none", "provider-override");
    }
  }

  // "fill-first" is the connection-selection strategy leaking into the same
  // field, never a proxy rotation — auth.js excludes it too.
  if (strategy !== "none" && strategy !== "fill-first") {
    const poolIds = resolveRotationPoolIds(allPools, override.proxyPoolIds, override.proxySource || "both");
    const usable = poolIds
      .map((id) => allPools.find((p) => p?.id === id))
      .filter(isUsablePool);
    if (usable.length > 0) {
      const nextId = peekProxyPoolId(poolIds, strategy, providerId, allPools);
      const next = usable.find((p) => p.id === nextId) || usable[0];
      return descriptorFor(next, usable, strategy, "rotation");
    }
  }

  return emptyProxyDescriptor();
}

/**
 * Provider-keyed map for the providers page: one settings read + one pool read
 * + one grouped SQL read for the whole grid. Providers with no proxy configured
 * are simply absent, so the UI's "no proxy ⇒ render nothing" rule is a key
 * lookup, not a condition ladder.
 */
export async function resolveProviderEffectiveProxyMap() {
  const out = {};
  let settings;
  let pools;
  let bindings;
  try {
    settings = (await getSettings()) || {};
  } catch {
    return out;
  }
  try {
    pools = (await getProxyPools({ isActive: true })) || [];
  } catch {
    pools = [];
  }
  try {
    bindings = (await getProviderConnectionProxyBindings()) || new Map();
  } catch {
    // Older DB or a partial install: fall back to the provider layer alone
    // rather than dropping every badge.
    bindings = new Map();
  }

  const strategies = settings.providerStrategies || {};
  const providers = new Set([...Object.keys(strategies), ...bindings.keys()]);
  for (const providerId of providers) {
    const override = strategies[providerId];
    const base =
      override && typeof override === "object"
        ? resolveProviderEffectiveProxy(override, pools, providerId)
        : emptyProxyDescriptor();
    const descriptor = mergeConnectionLayer(base, bindings.get(providerId), pools);
    if (descriptor.proxied || descriptor.poolMissing || descriptor.mixed) {
      out[providerId] = descriptor;
    }
  }
  return out;
}

/**
 * Turn one provider's aggregated connection bindings into a descriptor.
 *
 * A connection-level `providerSpecificData.proxyPoolId` is the FIRST thing
 * auth.js looks at (`if (!connPoolId) { …provider override, then rotation… }`),
 * so when every live connection of a provider is pinned to the same pool, that
 * pool — not the rotation badge — describes the traffic.
 *
 * `baseProxied` is whether the provider-level descriptor (override/rotation)
 * already reports a proxy. It only matters for the partial case: connections
 * with no binding fall through to the provider layer, so if that layer is
 * proxied, the answer for the provider is that proxy.
 *
 * @returns {object|null} null when no live connection is pinned or legacy-proxied
 */
export function resolveConnectionLayerProxy(binding, allPools = [], baseProxied = false) {
  if (!binding || !binding.active) return null;
  const byPool = binding.byPool instanceof Map ? binding.byPool : new Map();
  // A connection pinned to the "direct" pool is an explicit *direct* choice, not
  // a broken proxy: the connection dropdown writes proxyPoolId="direct" when the
  // operator picks Direct. Counting it as a dead pin would paint a red "missing"
  // badge over traffic that is behaving exactly as configured.
  const pinned = [...byPool.entries()].filter(([poolId]) => Boolean(poolId) && poolId !== "direct");
  const directPinned = Number(byPool.get("direct") || 0);
  const legacyCount = Number(binding.legacy || 0);
  const unboundCount = Number(byPool.get(null) || 0) + directPinned;

  // Every live connection explicitly pinned to the Direct pool. auth.js treats a
  // truthy connPoolId as "the answer" and never consults the provider override or
  // the rotation strategy, so a provider-level rotation badge would be a lie
  // here. Return a direct descriptor to suppress it — the UI renders nothing,
  // which is exactly right: this traffic is not proxied and nothing is broken.
  if (pinned.length === 0 && legacyCount === 0) {
    if (directPinned > 0) {
      return {
        proxied: false,
        directByConnection: true,
        poolId: "direct",
        poolName: "direct",
        host: "",
        strategy: "none",
        source: "connection",
        rotateLink: false,
        poolCount: 0,
        connectionCount: Number(binding.active) || directPinned,
      };
    }
    return null;
  }

  const groups = pinned.map(([poolId, count]) => {
    const pool = allPools.find((p) => p?.id === poolId);
    return {
      poolId,
      poolName: pool?.name || poolId,
      host: isUsablePool(pool) ? maskProxyHost(pool.proxyUrl) : "",
      rotateLink: Boolean(pool?.rotateLink || pool?.rotateUrl),
      usable: isUsablePool(pool),
      count: Number(count) || 0,
    };
  });
  if (legacyCount > 0) {
    groups.push({
      poolId: null,
      poolName: "legacy proxy",
      host: "",
      rotateLink: false,
      usable: true,
      count: legacyCount,
      legacy: true,
    });
  }

  const singlePinned = groups.length === 1 && unboundCount === 0 ? groups[0] : null;

  // Every live connection pinned to one place: a single, knowable answer that
  // overrides the provider-level badge entirely.
  if (singlePinned) {
    const connectionCount = Number(binding.active) || singlePinned.count;
    if (singlePinned.usable) {
      return {
        proxied: true,
        poolId: singlePinned.poolId,
        poolName: singlePinned.poolName,
        host: singlePinned.host,
        strategy: "none",
        source: "connection",
        rotateLink: singlePinned.rotateLink,
        poolCount: 1,
        connectionCount,
      };
    }
    // Pinned to a pool that is gone or switched off. resolveConnectionProxyConfig
    // falls through to direct in that case, so the traffic is NOT proxied while
    // the operator has every reason to believe it is. That is the single most
    // important thing this badge can report.
    return {
      proxied: false,
      poolId: singlePinned.poolId,
      poolName: singlePinned.poolName,
      host: "",
      strategy: "none",
      source: "connection",
      rotateLink: false,
      poolCount: 1,
      connectionCount,
      poolMissing: true,
      reason: `connections are pinned to proxy pool "${singlePinned.poolName}", which is missing or inactive`,
    };
  }

  // Unbound connections exist alongside pinned ones. They fall through to the
  // provider layer, so when that layer is proxied the provider answer is that
  // proxy; the pinned subset is an annotation, not a contradiction.
  if (unboundCount > 0 && baseProxied) {
    return { partial: true, pinnedGroups: groups, unboundCount, connectionCount: Number(binding.active) || 0 };
  }

  // Otherwise which pool carries a request depends on which connection the
  // router picks — no single pool can be named.
  const usableGroups = groups.filter((g) => g.usable);
  const named = groups.map((g) => g.poolName).join(", ");
  // Every pinned pool is gone: no connection can resolve a proxy, so the whole
  // provider falls through to direct while its rows still say "proxied".
  if (usableGroups.length === 0) {
    return {
      proxied: false,
      poolId: null,
      poolName: named,
      host: "",
      strategy: "none",
      source: "connection",
      rotateLink: false,
      poolCount: groups.length,
      connectionCount: Number(binding.active) || 0,
      poolMissing: true,
      reason: `connections are pinned to ${groups.length === 1 ? "a proxy pool" : "proxy pools"} that ${groups.length === 1 ? "is" : "are"} missing or inactive (${named})`,
    };
  }
  return {
    proxied: usableGroups.length > 0,
    mixed: true,
    poolId: null,
    // Unbound siblings mean some requests leave direct, so say so rather than
    // implying every request in this provider is proxied.
    poolName: groups.length === 1
      ? (unboundCount > 0 ? `${named} or direct` : named)
      : (unboundCount > 0 ? `mixed: ${named} or direct` : `mixed: ${named}`),
    host: "",
    strategy: "none",
    source: "connection-mixed",
    rotateLink: usableGroups.some((g) => g.rotateLink),
    poolCount: groups.length,
    connectionCount: Number(binding.active) || 0,
    groups,
    unboundCount,
  };
}

/**
 * Combine the provider-level descriptor with the connection layer.
 *
 * Ordering is auth.js ordering: a fully-pinned provider is decided by its
 * connections; a partial pin annotates the provider answer; no pin at all
 * leaves it untouched.
 */
export function mergeConnectionLayer(base, binding, allPools = []) {
  const connLayer = resolveConnectionLayerProxy(binding, allPools, Boolean(base?.proxied));
  if (!connLayer) return base;
  // Explicit Direct pin on every live connection wins over the provider layer:
  // auth.js never reaches the rotation branch when connPoolId is set.
  if (connLayer.directByConnection) return emptyProxyDescriptor();
  if (connLayer.partial) {
    return {
      ...base,
      pinnedElsewhere: true,
      pinnedGroups: connLayer.pinnedGroups,
      pinnedCount: connLayer.pinnedGroups.reduce((n, g) => n + g.count, 0),
    };
  }
  return connLayer;
}



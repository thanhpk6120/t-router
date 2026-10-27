import { getProxyPoolById, getProxyPools, isDirectProxyActive } from "@/models";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

/**
 * Pick one proxy pool ID from a list based on strategy.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * none/single: return first entry
 */
export function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!poolIds || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];

  if (strategy === "round-robin") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % poolIds.length;
    rotateState.set(providerId, state);
    return poolIds[state.index];
  }

  if (strategy === "random") {
    return poolIds[Math.floor(Math.random() * poolIds.length)];
  }

  if (strategy === "fallback") {
    return poolIds[0];
  }
  return poolIds[0]; // "none" or unknown
}

/**
 * Resolve which pool IDs a rotation runs over. A saved selection
 * (providerStrategies proxyPoolIds) restricts rotation to those pools;
 * an empty or absent selection keeps the legacy behavior of rotating
 * across every usable active pool.
 */
export function resolveRotationPoolIds(allPools, selectedIds, proxySource = "both") {
  let sourcePools = (allPools || []).filter((p) => p && p.id && p.proxyUrl);
  if (proxySource === "static") {
    const staticOnly = sourcePools.filter((p) => !p.rotateLink && !p.rotateUrl);
    if (staticOnly.length > 0) sourcePools = staticOnly;
  } else if (proxySource === "rotating") {
    const rotatingOnly = sourcePools.filter((p) => p.rotateLink || p.rotateUrl);
    if (rotatingOnly.length > 0) sourcePools = rotatingOnly;
  } else if (proxySource === "both") {
    // Rotating proxies first: always prioritize rotating proxies over static ones
    sourcePools.sort((a, b) => {
      const aRot = Boolean(a.rotateLink || a.rotateUrl);
      const bRot = Boolean(b.rotateLink || b.rotateUrl);
      if (aRot && !bRot) return -1;
      if (!aRot && bRot) return 1;
      return 0;
    });
  }

  const hasCustomProxies = sourcePools.some((p) => p.id !== "direct");
  let filtered = sourcePools;
  if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
    if (hasCustomProxies) {
      filtered = sourcePools.filter((p) => p.id !== "direct");
    }
  } else {
    const wanted = new Set(selectedIds);
    filtered = sourcePools.filter((p) => wanted.has(p.id));
  }

  if (proxySource === "both") {
    filtered.sort((a, b) => {
      const aRot = Boolean(a.rotateLink || a.rotateUrl);
      const bRot = Boolean(b.rotateLink || b.rotateUrl);
      if (aRot && !bRot) return -1;
      if (!aRot && bRot) return 1;
      return 0;
    });
  }

  return filtered.map((p) => p.id);
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    const directActive = await isDirectProxyActive().catch(() => true);
    let poolStrictProxy = false;

    const proxyIntended = Boolean(
      providerSpecificData?.proxyIntended === true ||
      (proxyPoolId && proxyPoolId !== "__none__") ||
      (legacy.connectionProxyEnabled && legacy.connectionProxyUrl)
    );
    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      poolStrictProxy = proxyPool?.strictProxy === true;

      if (isValidPool) {
        // Collect candidate proxies for in-pool fallback (rotating first, then static)
        let candidateProxies = [];
        try {
          const allActivePools = await getProxyPools({ isActive: true }).catch(() => []);
          let otherPools = allActivePools.filter((p) => p && p.id !== proxyPool.id && p.id !== "direct" && p.proxyUrl);
          if (Array.isArray(providerSpecificData?.providerProxyPoolIds) && providerSpecificData.providerProxyPoolIds.length > 0) {
            const allowed = new Set(providerSpecificData.providerProxyPoolIds);
            otherPools = otherPools.filter((p) => allowed.has(p.id));
          }
          otherPools.sort((a, b) => {
            const aRot = Boolean(a.rotateLink || a.rotateUrl);
            const bRot = Boolean(b.rotateLink || b.rotateUrl);
            if (aRot && !bRot) return -1;
            if (!aRot && bRot) return 1;
            return 0;
          });
          const ordered = [proxyPool, ...otherPools];
          candidateProxies = ordered.map((p) => ({
            id: p.id,
            name: p.name || p.id,
            proxyUrl: normalizeString(p.proxyUrl),
            rotateLink: normalizeString(p.rotateLink || p.rotateUrl),
            noProxy: normalizeString(p.noProxy),
            strictProxy: p.strictProxy === true,
            type: p.type || "http",
            isDirect: p.id === "direct" || p.type === "direct" || p.proxyUrl === "direct",
            vercelRelayUrl: ["vercel", "cloudflare", "deno", "netlify"].includes(p.type) ? normalizeString(p.proxyUrl) : "",
            proxyPool: p,
          })).filter(Boolean);
        } catch {}

        if (proxyPool.id === "direct" || proxyPool.type === "direct" || proxyPool.proxyUrl === "direct") {
          return {
            source: "direct",
            proxyPoolId: "direct",
            proxyPool,
            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,
            strictProxy: false,
            isDirect: true,
            directActive,
            proxyIntended: true,
            candidateProxies: candidateProxies.length > 0 ? candidateProxies : null,
          };
        }

        /**
         * Vercel/Cloudflare/Deno/Netlify relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify") {
          return {
            source: proxyPool.type,
            proxyPoolId,
            proxyPool,
            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,
            strictProxy: proxyPool.strictProxy === true,
            vercelRelayUrl: proxyUrl,
            directActive,
            proxyIntended: true,
            candidateProxies: candidateProxies.length > 0 ? candidateProxies : null,
          };
        }

        /**
         * Standard proxy pool
         */
        return {
          source: "pool",
          proxyPoolId,
          proxyPool,
          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,
          strictProxy: proxyPool.strictProxy === true,
          directActive,
          proxyIntended: true,
          candidateProxies: candidateProxies.length > 0 ? candidateProxies : null,
        };
      }
    }
    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        strictProxy: poolStrictProxy,
        directActive,
        proxyIntended: true,
        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      strictProxy: poolStrictProxy,
      directActive,
      proxyIntended,
      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
      directActive: true,
      proxyIntended: false,
    };
  }
}

/**
 * Auto proxy for connection TESTS (T Router): when a connection has
 * no proxy of its own, a test may borrow one from the active standard
 * pools (round-robin) so the test reflects proxied reality instead of
 * the server's direct IP. Best-effort only — callers fall back to a
 * direct test when the borrowed proxy fails its pre-check. Relay pools
 * (vercel/cloudflare/deno/netlify) are never borrowed. Returns a config
 * in the same shape as resolveConnectionProxyConfig, or null.
 */
export async function resolveAutoTestProxy() {
  try {
    const pools = await getProxyPools({ isActive: true });
    const RELAY_TYPES = ["vercel", "cloudflare", "deno", "netlify"];
    const standard = (pools || []).filter(
      (p) => p && normalizeString(p.proxyUrl) && !RELAY_TYPES.includes(p.type)
    );
    if (!standard.length) return null;
    const pickedId = pickProxyPoolId(standard.map((p) => p.id), "round-robin", "__autotest__");
    const pool = standard.find((p) => p.id === pickedId) || standard[0];
    return {
      source: "auto-pool",
      proxyPoolId: pool.id,
      proxyPool: pool,
      connectionProxyEnabled: true,
      connectionProxyUrl: normalizeString(pool.proxyUrl),
      connectionNoProxy: normalizeString(pool.noProxy),
      strictProxy: false,
      autoProxy: true,
    };
  } catch {
    return null;
  }
}

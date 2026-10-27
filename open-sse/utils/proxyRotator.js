import { ProxyAgent, fetch as undiciFetch } from "undici";
import { evictProxyDispatcher } from "./proxyFetch.js";
import { dbg } from "./debugLog.js";

// ─── Subnet & IP Range Normalization (mirroring opencode2api standard) ───────
// IPv4 is mapped to /24 (e.g. 1.2.3.4 -> 1.2.3.0/24)
// IPv6 is mapped to /48 (e.g. 2001:db8:1234:5678:: -> 2001:db8:1234::/48)
export function exitRange(address) {
  if (!address || typeof address !== "string") return "";
  const clean = address.trim();
  if (!clean) return "";

  // Check IPv4
  const v4Match = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4Match) {
    const [, a, b, c] = v4Match;
    return `${a}.${b}.${c}.0/24`;
  }

  // Check IPv6
  if (clean.includes(":")) {
    try {
      // Expand compressed :: notation into full 8 groups
      let parts = [];
      if (clean.includes("::")) {
        const [left, right] = clean.split("::");
        const leftParts = left ? left.split(":") : [];
        const rightParts = right ? right.split(":") : [];
        const missingCount = 8 - (leftParts.length + rightParts.length);
        const middleParts = Array(Math.max(0, missingCount)).fill("0");
        parts = [...leftParts, ...middleParts, ...rightParts];
      } else {
        parts = clean.split(":");
      }

      if (parts.length >= 8) {
        const g0 = (parseInt(parts[0], 16) || 0).toString(16);
        const g1 = (parseInt(parts[1], 16) || 0).toString(16);
        const g2 = (parseInt(parts[2], 16) || 0).toString(16);
        return `${g0}:${g1}:${g2}::/48`.toLowerCase();
      }
    } catch {
      // Fallback
    }
  }

  return clean;
}

// ─── Bounded FIFO Cache for Known-Bad Exit Ranges ─────────────────────────────
const DEFAULT_BAD_CACHE_SIZE = 10;
const badExitRanges = []; // FIFO array of known-bad range keys

export function markBadRange(rangeKey, maxCacheSize = DEFAULT_BAD_CACHE_SIZE) {
  if (!rangeKey || typeof rangeKey !== "string") return;
  const key = rangeKey.trim();
  if (!key) return;

  const limit = Number.isFinite(Number(maxCacheSize)) && Number(maxCacheSize) > 0
    ? Number(maxCacheSize)
    : DEFAULT_BAD_CACHE_SIZE;

  const idx = badExitRanges.indexOf(key);
  if (idx !== -1) {
    // Move to end (MRU)
    badExitRanges.splice(idx, 1);
  }
  badExitRanges.push(key);
  if (badExitRanges.length > limit) {
    badExitRanges.splice(0, badExitRanges.length - limit);
  }
  dbg("ProxyRotator", `Marked exit range as bad: ${key} (total bad: ${badExitRanges.length}/${limit})`);
}

export function isBadRange(rangeKey) {
  if (!rangeKey || typeof rangeKey !== "string") return false;
  return badExitRanges.includes(rangeKey.trim());
}

export function getBadRanges() {
  return [...badExitRanges];
}

export function clearBadRanges() {
  badExitRanges.length = 0;
}

// ─── Active Refreshing Proxies Tracking ───────────────────────────────────────
const refreshingProxies = new Set(); // Set of proxyUrl currently in renewal

export function isProxyRefreshing(proxyUrl) {
  if (!proxyUrl) return false;
  return refreshingProxies.has(proxyUrl);
}

export function setProxyRefreshing(proxyUrl, isRefreshing) {
  if (!proxyUrl) return;
  if (isRefreshing) refreshingProxies.add(proxyUrl);
  else refreshingProxies.delete(proxyUrl);
}

// ─── Last Known Exit Ranges ───────────────────────────────────────────────────
const lastKnownRanges = new Map(); // proxyUrl -> last known exit range

export function setKnownProxyRange(proxyUrl, range) {
  if (proxyUrl && range) lastKnownRanges.set(proxyUrl, range);
}

export function getKnownProxyRange(proxyUrl) {
  if (!proxyUrl) return "";
  return lastKnownRanges.get(proxyUrl) || "";
}

export function isProxyBadOrRefreshing(proxyUrl) {
  if (!proxyUrl) return false;
  if (isProxyRefreshing(proxyUrl)) return true;
  const known = lastKnownRanges.get(proxyUrl);
  if (known && isBadRange(known)) return true;
  return false;
}

// ─── Probe Exit IP through Proxy ──────────────────────────────────────────────
const PROBE_URLS = [
  "https://cloudflare.com/cdn-cgi/trace",
  "https://api.ipify.org",
  "https://ifconfig.me/ip",
];

export async function probeExitRange(proxyUrl, timeoutMs = 6000) {
  if (!proxyUrl || typeof proxyUrl !== "string") return "";
  let dispatcher;
  try {
    dispatcher = new ProxyAgent({ uri: proxyUrl });
  } catch (err) {
    dbg("ProxyRotator", `Cannot create dispatcher for probe ${proxyUrl}: ${err.message}`);
    return "";
  }

  for (const probeUrl of PROBE_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await undiciFetch(probeUrl, {
        method: "GET",
        dispatcher,
        signal: controller.signal,
        headers: { "User-Agent": "TRouter/Probe" },
      });
      clearTimeout(timer);
      if (!res.ok) continue;

      const text = await res.text();
      let ip = "";
      if (probeUrl.includes("cdn-cgi/trace")) {
        const match = text.match(/(?:^|\n)ip=([^\r\n]+)/);
        if (match) ip = match[1].trim();
      } else {
        const match = text.match(/([a-fA-F0-9.:]{7,45})/);
        if (match) ip = match[1].trim();
      }

      if (ip) {
        const range = exitRange(ip);
        lastKnownRanges.set(proxyUrl, range);
        dbg("ProxyRotator", `Probed proxy ${proxyUrl} exit range: ${range} (raw IP: ${ip})`);
        return range;
      }
    } catch (err) {
      clearTimeout(timer);
      dbg("ProxyRotator", `Probe ${probeUrl} failed through ${proxyUrl}: ${err.message}`);
    }
  }

  return "";
}

// ─── Note Failure Range Before Rotation ───────────────────────────────────────
// Synchronously/awaitable records the failing exit range BEFORE changing it (opencode2api standard)
export async function noteFailureRange(proxyUrl, exitIp = null, maxCacheSize = DEFAULT_BAD_CACHE_SIZE) {
  if (!proxyUrl) return "";
  if (exitIp) {
    const range = exitRange(exitIp);
    lastKnownRanges.set(proxyUrl, range);
    markBadRange(range, maxCacheSize);
    return range;
  }

  const cachedRange = lastKnownRanges.get(proxyUrl);
  if (cachedRange) {
    markBadRange(cachedRange, maxCacheSize);
    return cachedRange;
  }

  // Probe before rotateLink changes the IP
  try {
    const range = await probeExitRange(proxyUrl, 4000);
    if (range) {
      lastKnownRanges.set(proxyUrl, range);
      markBadRange(range, maxCacheSize);
      return range;
    }
  } catch {}

  return "";
}

// ─── Smart Rotating Proxy Renewal with Range Verification ────────────────────
const MAX_ROTATE_ATTEMPTS = 5;
const ROTATE_SLOT_MIN_INTERVAL_MS = 2500;
const inflightRotations = new Map(); // rotateLink -> Promise
const lastRotationTimestamps = new Map(); // rotateLink -> timestamp

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rotate proxy exit IP using rotateLink with Bad Range avoidance.
 * 1. Suspends proxy (refreshing = true).
 * 2. Remembers failing exit range before rotateLink is called.
 * 3. Calls rotateLink and probes new exit address.
 * 4. If new exit address is known-bad, automatically rotates again up to 5 times.
 * 5. Returns proxy to service when clean exit is verified.
 */
export async function rotateProxyWithRangeCheck(rotateLink, proxyUrl = null, options = {}) {
  if (!rotateLink) return { ok: false, error: "no_rotate_link" };

  if (proxyUrl) {
    setProxyRefreshing(proxyUrl, true);
  }

  // Deduplicate concurrent rotations for the same link
  if (inflightRotations.has(rotateLink)) {
    dbg("ProxyRotator", `Awaiting existing in-flight rotation for ${rotateLink}`);
    return inflightRotations.get(rotateLink);
  }

  const rotationPromise = (async () => {
    try {
      // Step A: Note failure range of the old exit before rotateLink changes it
      if (proxyUrl) {
        await noteFailureRange(proxyUrl, null, options?.failedIpCacheSize).catch(() => {});
      }

      const minIntervalSec = Number.isFinite(Number(options?.minIntervalSeconds)) && Number(options.minIntervalSeconds) > 0
        ? Number(options.minIntervalSeconds)
        : 60;
      const minIntervalMs = Math.max(ROTATE_SLOT_MIN_INTERVAL_MS, minIntervalSec * 1000);

      const now = Date.now();
      const last = lastRotationTimestamps.get(rotateLink) || 0;
      if (now - last < minIntervalMs) {
        const waitMs = minIntervalMs - (now - last);
        await sleep(waitMs);
      }

      for (let attempt = 0; attempt < MAX_ROTATE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          // Space out retry rotations by minIntervalMs (or slot interval)
          await sleep(Math.min(minIntervalMs, 5000));
        }
        lastRotationTimestamps.set(rotateLink, Date.now());
        dbg("ProxyRotator", `Calling rotate link (attempt ${attempt + 1}/${MAX_ROTATE_ATTEMPTS}): ${rotateLink}`);

        let res;
        try {
          res = await undiciFetch(rotateLink, {
            method: "GET",
            signal: AbortSignal.timeout(15000),
            headers: { "User-Agent": "TRouter/Rotator" },
          });
        } catch (callErr) {
          console.warn(`[ProxyRotator] Rotate link request error: ${callErr.message}`);
          continue;
        }

        if (!res.ok) {
          console.warn(`[ProxyRotator] Rotate link returned status ${res.status}`);
          continue;
        }

        // Close kept-alive tunnels so next connections use the new exit IP
        if (proxyUrl) {
          evictProxyDispatcher(proxyUrl);
        }

        // Wait brief moment for the proxy provider network to switch egress IP
        await sleep(1500);

        if (!proxyUrl) {
          return { ok: true, attempts: attempt + 1 };
        }

        // Probe the new exit address
        const newRange = await probeExitRange(proxyUrl, 6000);
        if (newRange) {
          lastKnownRanges.set(proxyUrl, newRange);
          const isBad = isBadRange(newRange);
          if (isBad) {
            console.warn(`[ProxyRotator] Proxy ${proxyUrl} rotated to known-bad exit range ${newRange}. Retrying rotation... (attempt ${attempt + 1}/${MAX_ROTATE_ATTEMPTS})`);
            continue; // Re-rotate!
          }

          console.info(`[ProxyRotator] Proxy ${proxyUrl} rotated successfully to clean exit range ${newRange} (attempt ${attempt + 1})`);
          return { ok: true, exitRange: newRange, attempts: attempt + 1 };
        } else {
          // Exit unreadable (probe timed out), but rotate link succeeded: accept on reachability
          console.info(`[ProxyRotator] Proxy ${proxyUrl} rotate link succeeded (exit unreadable, accepted on reachability)`);
          return { ok: true, exitRange: "", attempts: attempt + 1 };
        }
      }

      console.warn(`[ProxyRotator] Proxy ${proxyUrl} rotation exhausted after ${MAX_ROTATE_ATTEMPTS} attempts landing on bad ranges`);
      return { ok: false, error: "exhausted_bad_ranges" };
    } finally {
      if (proxyUrl) {
        setProxyRefreshing(proxyUrl, false);
      }
      inflightRotations.delete(rotateLink);
    }
  })();

  inflightRotations.set(rotateLink, rotationPromise);
  return rotationPromise;
}

/**
 * Fire-and-forget background rotation triggered upon proxy failure or 429/403
 */
export function triggerBackgroundRotate(rotateLink, proxyUrl = null, pool = null) {
  if (!rotateLink) return;
  if (pool?.autoRotate === false) {
    if (proxyUrl) {
      noteFailureRange(proxyUrl, null, pool?.failedIpCacheSize).catch(() => {});
    }
    dbg("ProxyRotator", `Auto-rotate skipped for pool ${pool?.name || pool?.id}: autoRotate disabled`);
    return;
  }

  const options = {
    minIntervalSeconds: pool?.minIntervalSeconds,
    maxIntervalSeconds: pool?.maxIntervalSeconds,
    failedIpCacheSize: pool?.failedIpCacheSize,
  };

  rotateProxyWithRangeCheck(rotateLink, proxyUrl, options)
    .then((result) => {
      if (result.ok && pool?.id) {
        tryUpdatePoolDb(pool.id, result.exitRange).catch(() => {});
      }
    })
    .catch((err) => {
      console.warn(`[ProxyRotator] Background rotation failed: ${err.message}`);
    });
}

async function tryUpdatePoolDb(poolId, exitRange) {
  try {
    const { updateProxyPool } = await import(/* webpackIgnore: true */ "../../src/lib/db/repos/proxyPoolsRepo.js");
    if (typeof updateProxyPool === "function") {
      await updateProxyPool(poolId, {
        lastRotatedAt: new Date().toISOString(),
        lastExitRange: exitRange || undefined,
      });
    }
  } catch {}
}

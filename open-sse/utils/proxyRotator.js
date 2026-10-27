import { ProxyAgent, fetch as undiciFetch } from "undici";
import { evictProxyDispatcher } from "./proxyFetch.js";
import { dbg } from "./debugLog.js";

// ─── Subnet & IP Range Normalization (mirroring opencode2api standard) ───────
// IPv4 is mapped to /24 (e.g. 1.2.3.4 -> 1.2.3.0/24)
// IPv6 is mapped to /48 (e.g. 2402:800:61c3:1234:: -> 2402:800:61c3::/48)
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
    const parts = clean.split(":").filter(Boolean);
    if (parts.length >= 3) {
      return `${parts[0]}:${parts[1]}:${parts[2]}::/48`.toLowerCase();
    }
  }

  return clean;
}

// ─── Bounded FIFO Cache for Known-Bad Exit Ranges ─────────────────────────────
const MAX_BAD_RANGES = 100;
const badExitRanges = []; // FIFO array of known-bad range keys

export function markBadRange(rangeKey) {
  if (!rangeKey || typeof rangeKey !== "string") return;
  const key = rangeKey.trim();
  if (!key) return;

  const idx = badExitRanges.indexOf(key);
  if (idx !== -1) {
    // Already in cache, move to end (MRU)
    badExitRanges.splice(idx, 1);
  }
  badExitRanges.push(key);
  if (badExitRanges.length > MAX_BAD_RANGES) {
    badExitRanges.shift();
  }
  dbg("ProxyRotator", `Marked exit range as bad: ${key} (total bad: ${badExitRanges.length})`);
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
const lastKnownRanges = new Map(); // proxyUrl -> last known exit range

export function setKnownProxyRange(proxyUrl, range) {
  if (proxyUrl && range) lastKnownRanges.set(proxyUrl, range);
}

export function noteFailureRange(proxyUrl, exitIp = null) {
  if (!proxyUrl) return;
  if (exitIp) {
    const range = exitRange(exitIp);
    markBadRange(range);
    return;
  }

  const cachedRange = lastKnownRanges.get(proxyUrl);
  if (cachedRange) {
    markBadRange(cachedRange);
    return;
  }

  // Probe in background so we remember the failing exit range
  probeExitRange(proxyUrl, 5000)
    .then((range) => {
      if (range) {
        lastKnownRanges.set(proxyUrl, range);
        markBadRange(range);
      }
    })
    .catch(() => {});
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
 * Rotate proxy exit IP using rotateLink.
 * If the resulting IP is in the known-bad range cache, rotates again up to 5 times.
 */
export async function rotateProxyWithRangeCheck(rotateLink, proxyUrl = null, options = {}) {
  if (!rotateLink) return { ok: false, error: "no_rotate_link" };

  // Deduplicate concurrent rotations for the same link
  if (inflightRotations.has(rotateLink)) {
    dbg("ProxyRotator", `Awaiting existing in-flight rotation for ${rotateLink}`);
    return inflightRotations.get(rotateLink);
  }

  const rotationPromise = (async () => {
    try {
      const now = Date.now();
      const last = lastRotationTimestamps.get(rotateLink) || 0;
      if (now - last < ROTATE_SLOT_MIN_INTERVAL_MS) {
        const waitMs = ROTATE_SLOT_MIN_INTERVAL_MS - (now - last);
        await sleep(waitMs);
      }

      for (let attempt = 0; attempt < MAX_ROTATE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          // Delay between retries to avoid overwhelming provider rotation endpoint
          await sleep(ROTATE_SLOT_MIN_INTERVAL_MS);
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

        // Close kept-alive tunnels so new requests bind to the new exit IP
        if (proxyUrl) {
          evictProxyDispatcher(proxyUrl);
        }

        // Wait brief moment for the proxy backend to switch route
        await sleep(1500);

        // If no proxyUrl provided (just rotate link), accept success directly
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
  rotateProxyWithRangeCheck(rotateLink, proxyUrl)
    .then((result) => {
      if (result.ok && pool?.id) {
        // Try updating database if running inside full Next.js context
        tryUpdatePoolDb(pool.id, result.exitRange).catch(() => {});
      }
    })
    .catch((err) => {
      console.warn(`[ProxyRotator] Background rotation failed: ${err.message}`);
    });
}

async function tryUpdatePoolDb(poolId, exitRange) {
  try {
    const { updateProxyPool } = await import("../../src/lib/db/repos/proxyPoolsRepo.js");
    if (typeof updateProxyPool === "function") {
      await updateProxyPool(poolId, {
        lastRotatedAt: new Date().toISOString(),
        lastExitRange: exitRange || undefined,
      });
    }
  } catch {}
}

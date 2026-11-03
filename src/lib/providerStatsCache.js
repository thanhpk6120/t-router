// Shared providers summary cache (opt14 m3). Previously module-level state
// inside api/providers/route.js, unreachable from [id] PUT/DELETE and
// test-batch, so those writes left stale counts for up to 30s. Every
// providers write path imports this module and invalidates after mutating.
// Next.js route modules share this lib module instance in one server process.
let cache = { at: 0, data: null };

export const STATS_TTL_MS = 30_000;

export function getStatsCache() {
  // Return the cached map, or null when absent/expired. Callers test this
  // value directly (`if (!data) recompute`), so returning the {at,data}
  // wrapper made the truthiness check always pass and stats stayed null.
  if (cache.data && Date.now() - cache.at < STATS_TTL_MS) return cache.data;
  return null;
}

export function setStatsCache(data) {
  cache = { at: Date.now(), data };
}

export function invalidateStatsCache() {
  cache = { at: 0, data: null };
}

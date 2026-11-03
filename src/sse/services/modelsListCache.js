// Key-scoped /v1/models cache. Building the list hits the DB and runs live
// provider catalog fetches, so GET /v1/models caches its final filtered
// list per API key for a short TTL. Entries are keyed by API key id
// (restricted keys) or "full" (unrestricted keys, which all see the same
// unfiltered list), so one key's list can never serve another key.
// Writes that change the listed set invalidate via
// invalidateModelsListCache(), called from the repo mutators (connections,
// combos, variants, aliases, custom models, disabled models, API keys).
// Staleness is bounded by the TTL even if a write path is missed.
const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;
const entries = new Map();

export function getModelsListCache(key) {
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    entries.delete(key);
    return null;
  }
  return entry.data;
}

export function setModelsListCache(key, data) {
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, { at: Date.now(), data });
}

// Additional caches elsewhere (e.g. the 30s catalog payload in
// /api/models) register here so a single repo-level write invalidates every
// model list, not just this module's key-scoped cache.
const listeners = new Set();

export function onInvalidateModelsListCache(fn) {
  if (typeof fn === "function") listeners.add(fn);
  return () => listeners.delete(fn);
}

export function invalidateModelsListCache() {
  entries.clear();
  for (const fn of listeners) {
    try { fn(); } catch { /* a broken listener must not block the write path */ }
  }
}

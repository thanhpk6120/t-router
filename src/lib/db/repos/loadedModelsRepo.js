// Loaded model catalogs, persisted per provider/connection.
//
// The provider detail page used to hit the upstream /models endpoint on every
// visit, so opening a provider cost a live round-trip (and on a slow provider,
// seconds) just to render a list that had not changed. The catalog is now
// stored on first load and served from here; only an explicit "Load models
// from provider" (?refresh=1) asks the upstream again.
import { makeKv } from "../helpers/kvStore.js";

const kv = makeKv("loadedModels");

/** @returns {Promise<{models: object[], updatedAt: string, source?: string}|null>} */
export async function getLoadedModels(key) {
  if (!key) return null;
  const row = await kv.get(key);
  if (!row || !Array.isArray(row.models) || row.models.length === 0) return null;
  return row;
}

export async function setLoadedModels(key, payload) {
  if (!key) return;
  await kv.set(key, {
    models: Array.isArray(payload?.models) ? payload.models : [],
    updatedAt: payload?.updatedAt || new Date().toISOString(),
    source: payload?.source || "live",
  });
}

export async function clearLoadedModels(key) {
  if (key) await kv.remove(key);
}

// Response cache: exact replays for non-streaming chat
// completions. Scope is deliberately narrow — tool calls are never replayed
// (the client would re-act on stale tool calls), and streaming responses
// pass through untouched. The key covers the WHOLE request body except
// `stream`, so any parameter change is a different entry. Opt-in only.
import { createHash } from "node:crypto";

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// Cacheable = a plain chat-completions body that will not stream and asks
// for no tools. Everything else returns null (caller passes through).
export function buildCacheKey(body) {
  if (!body || typeof body !== "object") return null;
  if (body.stream === true) return null;
  if (body.tools || body.tool_choice || body.functions) return null;
  if (typeof body.model !== "string" || !body.model) return null;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
  const { stream, ...rest } = body;
  return createHash("sha256").update(stableStringify(rest)).digest("hex");
}

export function cacheableResponse(json) {
  return Boolean(json && typeof json === "object" && Array.isArray(json.choices) && json.choices.length > 0);
}

export async function getCached(db, key) {
  try {
    const row = db.get(`SELECT response, expiresAt FROM responseCache WHERE key = ?`, [key]);
    if (!row) return null;
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
      try { db.run(`DELETE FROM responseCache WHERE key = ?`, [key]); } catch {}
      return null;
    }
    return JSON.parse(row.response);
  } catch {
    return null;
  }
}

export async function putCached(db, key, responseJson, ttlSeconds = 3600, maxEntries = 1000) {
  if (!key || !cacheableResponse(responseJson)) return false;
  const now = Date.now();
  const expiresAt = new Date(now + Math.max(1, ttlSeconds) * 1000).toISOString();
  const createdAt = new Date(now).toISOString();
  try {
    db.run(
      `INSERT INTO responseCache (key, response, createdAt, expiresAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET response = excluded.response, expiresAt = excluded.expiresAt`,
      [key, JSON.stringify(responseJson), createdAt, expiresAt]
    );

    // Bounded size: prune oldest rows when past maxEntries.
    if (maxEntries > 0) {
      db.run(
        `DELETE FROM responseCache WHERE key IN (
           SELECT key FROM responseCache ORDER BY createdAt DESC LIMIT -1 OFFSET ?
         )`,
        [maxEntries]
      );
    }
    return true;
  } catch {
    return false;
  }
}

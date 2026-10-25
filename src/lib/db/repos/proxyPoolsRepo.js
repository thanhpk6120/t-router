import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
export const DIRECT_PROXY_ID = "direct";
export const DIRECT_PROXY_NAME = "Direct";

function ensureDirectPool(db) {
  try {
    const row = db.get("SELECT id FROM proxyPools WHERE id = ?", [DIRECT_PROXY_ID]);
    if (!row) {
      const now = new Date().toISOString();
      const directPool = {
        id: DIRECT_PROXY_ID,
        name: DIRECT_PROXY_NAME,
        proxyUrl: "direct",
        noProxy: "",
        rotateLink: "",
        type: "direct",
        isActive: true,
        strictProxy: false,
        testStatus: "active",
        lastTestedAt: now,
        lastRotatedAt: null,
        lastRotateResponse: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
      };
      upsert(db, directPool);
    }
  } catch {}
}

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, p) {
  const r = poolToRow(p);
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProxyPools(filter = {}) {
  const db = await getAdapter();
  ensureDirectPool(db);
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.testStatus) { where.push("testStatus = ?"); params.push(filter.testStatus); }
  const sql = `SELECT * FROM proxyPools${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const list = db.all(sql, params).map(rowToPool);
  list.sort((a, b) => {
    if (a.id === DIRECT_PROXY_ID) return -1;
    if (b.id === DIRECT_PROXY_ID) return 1;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  return list;
}

export async function getProxyPoolById(id) {
  const db = await getAdapter();
  return rowToPool(db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]));
}

export async function isDirectProxyActive() {
  const db = await getAdapter();
  ensureDirectPool(db);
  const row = db.get("SELECT isActive FROM proxyPools WHERE id = ?", [DIRECT_PROXY_ID]);
  return row ? (row.isActive === 1 || row.isActive === true) : true;
}


export async function createProxyPool(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    rotateLink: data.rotateLink || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastRotatedAt: data.lastRotatedAt || null,
    lastRotateResponse: data.lastRotateResponse || null,
    lastError: data.lastError || null,
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, pool);
  return pool;
}

export async function updateProxyPool(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToPool(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteProxyPool(id) {
  if (id === DIRECT_PROXY_ID) return null; // Direct proxy cannot be deleted
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToPool(row);
    db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
  });
  return removed;
}

export async function deleteProxyPoolsByIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const safeIds = ids.filter(id => id !== DIRECT_PROXY_ID);
  if (!safeIds.length) return 0;
  const db = await getAdapter();
  let changes = 0;
  db.transaction(() => {
    for (const id of safeIds) {
      const info = db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
      changes += info?.changes ?? 0;
    }
  });
  return changes;
}

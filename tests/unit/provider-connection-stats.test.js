// getProviderConnectionStats: a connection counts as "connected" unless it
// carries a concrete failure status. "unknown" (never tested) used to fall
// through both branches, leaving connected=0/error=0 and printing
// "No connections" on the providers grid despite rows existing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-conn-stats-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  // The SQLite adapter keeps the file handle open for the process lifetime;
  // Windows refuses to delete it (EPERM/EBUSY). Cleanup is best-effort.
  if (tempDir) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* locked on Windows */ }
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function addConn({ provider, authType = "apikey", name, isActive = true, ...extra }) {
  return db.createProviderConnection({
    provider,
    authType,
    name,
    apiKey: "k",
    isActive,
    ...extra,
  });
}

function statsFor(stats, provider, authType = "apikey") {
  return stats[`${provider}|${authType}`];
}

describe("getProviderConnectionStats — status mapping", () => {
  it("counts a never-tested connection (testStatus 'unknown') as connected", async () => {
    await addConn({ provider: "stats-unknown", name: "u1", testStatus: "unknown" });
    const stats = await db.getProviderConnectionStats();
    const s = statsFor(stats, "stats-unknown");
    expect(s.total).toBe(1);
    expect(s.connected).toBe(1);
    expect(s.error).toBe(0);
  });

  it("counts a connection with no testStatus at all as connected", async () => {
    await addConn({ provider: "stats-null", name: "n1" });
    const stats = await db.getProviderConnectionStats();
    const s = statsFor(stats, "stats-null");
    expect(s.total).toBe(1);
    expect(s.connected).toBe(1);
    expect(s.error).toBe(0);
  });

  it("counts active/success as connected", async () => {
    await addConn({ provider: "stats-active", name: "a1", testStatus: "active" });
    await addConn({ provider: "stats-active", name: "a2", testStatus: "success" });
    const s = statsFor(await db.getProviderConnectionStats(), "stats-active");
    expect(s.total).toBe(2);
    expect(s.connected).toBe(2);
    expect(s.error).toBe(0);
  });

  it("counts error/expired as error, not connected", async () => {
    await addConn({ provider: "stats-err", name: "e1", testStatus: "error" });
    await addConn({ provider: "stats-err", name: "e2", testStatus: "expired" });
    const s = statsFor(await db.getProviderConnectionStats(), "stats-err");
    expect(s.total).toBe(2);
    expect(s.connected).toBe(0);
    expect(s.error).toBe(2);
    expect(s.latestError).toBeTruthy();
  });

  it("counts 'unavailable' as connected when no modelLock is in the future", async () => {
    await addConn({ provider: "stats-unavail", name: "v1", testStatus: "unavailable" });
    const s = statsFor(await db.getProviderConnectionStats(), "stats-unavail");
    expect(s.total).toBe(1);
    expect(s.connected).toBe(1);
    expect(s.error).toBe(0);
  });

  it("counts 'unavailable' as error while a modelLock is still cooling", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    // modelLock_* keys are not in OPTIONAL_FIELDS, so createProviderConnection
    // drops them. The runtime (auth.js) writes them through
    // updateProviderConnection, which merges into the JSON data column.
    const conn = await addConn({
      provider: "stats-cooling",
      name: "c1",
      testStatus: "unavailable",
    });
    await db.updateProviderConnection(conn.id, { "modelLock_some/model": future });
    const s = statsFor(await db.getProviderConnectionStats(), "stats-cooling");
    expect(s.total).toBe(1);
    expect(s.connected).toBe(0);
    expect(s.error).toBe(1);
  });

  it("counts 'unavailable' as connected when the lock is in the past", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const conn = await addConn({
      provider: "stats-expired-lock",
      name: "p1",
      testStatus: "unavailable",
    });
    await db.updateProviderConnection(conn.id, { "modelLock_some/model": past });
    const s = statsFor(await db.getProviderConnectionStats(), "stats-expired-lock");
    expect(s.total).toBe(1);
    expect(s.connected).toBe(1);
    expect(s.error).toBe(0);
  });

  it("never yields a row with total > 0 but connected = error = 0", async () => {
    await addConn({ provider: "stats-invariant", name: "i1", testStatus: "unknown" });
    await addConn({ provider: "stats-invariant", name: "i2", testStatus: "error" });
    await addConn({ provider: "stats-invariant", name: "i3", testStatus: "active" });
    const s = statsFor(await db.getProviderConnectionStats(), "stats-invariant");
    expect(s.total).toBe(3);
    expect(s.connected + s.error).toBe(s.total);
  });

  it("tracks allDisabled from isActive", async () => {
    await addConn({ provider: "stats-disabled", name: "d1", isActive: false });
    const s = statsFor(await db.getProviderConnectionStats(), "stats-disabled");
    expect(s.total).toBe(1);
    expect(s.allDisabled).toBe(true);
  });
});
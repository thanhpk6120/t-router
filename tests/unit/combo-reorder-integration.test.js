import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let reorderPost;
let combosGet;
let comboDelete;
let guardProxy;

describe("combo reorder end-to-end persistence & UI contracts", () => {
  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-reorder-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();

    db = await import("@/lib/db/index.js");
    await db.initDb();

    ({ POST: reorderPost } = await import("@/app/api/combos/reorder/route.js"));
    ({ GET: combosGet } = await import("@/app/api/combos/route.js"));
    ({ DELETE: comboDelete } = await import("@/app/api/combos/[id]/route.js"));
    ({ proxy: guardProxy } = await import("../../src/dashboardGuard.js"));
  });

  afterAll(() => {
    try {
      db?.closeAdapter?.();
    } catch {}
    delete global._dbAdapter;
    try {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  beforeEach(async () => {
    const existing = await db.getCombos();
    for (const c of existing) {
      await db.deleteCombo(c.id);
    }
    await db.updateSettings({ comboOrder: [] });
  });

  it("persists combo order to SQLite, invalidates settings cache, and returns sorted combos from GET /api/combos", async () => {
    const c1 = await db.createCombo({ name: "combo-a", models: ["openai/gpt-4o"] });
    const c2 = await db.createCombo({ name: "combo-b", models: ["openai/gpt-4o-mini"] });
    const c3 = await db.createCombo({ name: "combo-c", models: ["anthropic/claude-3-5-sonnet"] });

    // Warm settings cache before reordering to verify cache invalidation works end-to-end.
    const before = await (await combosGet()).json();
    expect(before.combos.map((c) => c.id)).toEqual([c1.id, c2.id, c3.id]);

    const req = new Request("http://localhost/api/combos/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comboIds: [c3.id, c1.id, c2.id] }),
    });
    const res = await reorderPost(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, count: 3 });

    const settings = await db.getSettings();
    expect(settings.comboOrder).toEqual([c3.id, c1.id, c2.id]);

    const after = await (await combosGet()).json();
    expect(after.combos.map((c) => c.id)).toEqual([c3.id, c1.id, c2.id]);
  });

  it("returns 400 instead of 500 on malformed JSON body", async () => {
    const req = new Request("http://localhost/api/combos/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad-json",
    });
    const res = await reorderPost(req);
    expect(res.status).toBe(400);
  });

  it("prunes deleted combo ID from settings.comboOrder on DELETE /api/combos/[id]", async () => {
    const c1 = await db.createCombo({ name: "keep-1", models: ["openai/gpt-4o"] });
    const c2 = await db.createCombo({ name: "drop-2", models: ["openai/gpt-4o-mini"] });
    const c3 = await db.createCombo({ name: "keep-3", models: ["anthropic/claude-3-5-sonnet"] });

    await reorderPost(new Request("http://localhost/api/combos/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comboIds: [c3.id, c2.id, c1.id] }),
    }));

    const delRes = await comboDelete(
      new Request(`http://localhost/api/combos/${c2.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: c2.id }) },
    );
    expect(delRes.status).toBe(200);

    const settings = await db.getSettings();
    expect(settings.comboOrder).toEqual([c3.id, c1.id]);

    const after = await (await combosGet()).json();
    expect(after.combos.map((c) => c.id)).toEqual([c3.id, c1.id]);
  });

  it("requires authentication on /api/combos/reorder when requireLogin is enabled", async () => {
    await db.updateSettings({ requireLogin: true });
    const req = {
      nextUrl: new URL("http://127.0.0.1:20126/api/combos/reorder"),
      url: "http://127.0.0.1:20126/api/combos/reorder",
      headers: new Headers(),
      cookies: { get: () => undefined },
    };
    const res = await guardProxy(req);
    expect(res.status).toBe(401);
  });

  it("combos page preserves hidden capacityAdapter keys, reports HTTP status, and clears failed state per retry", () => {
    const page = readFileSync(path.join(root, "src/app/(dashboard)/dashboard/combos/page.js"), "utf8");
    expect(page).toContain("const normalized = { ...rawAdapter };");
    expect(page).toContain("lastError = null;");
    expect(page).toContain("throw new Error(errData.error || `HTTP ${res.status}`);");
    expect(page).toContain("const dragDisabled = Boolean(normalizedQuery) || combos.length < 2;");
    expect(page).toContain("fetch(\"/api/combos/reorder\"");
  });
});

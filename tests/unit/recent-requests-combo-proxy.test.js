import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trouter-recent-combo-proxy-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  global._recentRing = { items: [], initialized: false };
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  try {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Recent Requests combo & proxy persistence", () => {
  it("persists and exposes combo and proxy across getUsageStats, live recentRing, and cold-start reload", async () => {
    const baseTs = Date.now();
    const ts = (offsetMs) => new Date(baseTs + offsetMs).toISOString();

    await db.saveRequestUsage({
      requestId: "req-combo-proxied",
      timestamp: ts(100),
      provider: "openai",
      model: "gpt-4.1",
      combo: "my-fast-combo",
      proxy: { proxied: true, poolId: "p1", poolName: "VN-Residential", host: "http://10.2.3.4:8080", type: "http" },
      tokens: { prompt_tokens: 100, completion_tokens: 20 },
      latencyMs: 320,
    });

    await db.saveRequestUsage({
      requestId: "req-combo-direct",
      timestamp: ts(200),
      provider: "anthropic",
      model: "claude-sonnet-4",
      combo: "claude-combo",
      proxy: { proxied: false },
      tokens: { prompt_tokens: 50, completion_tokens: 10 },
      latencyMs: 210,
    });

    await db.saveRequestUsage({
      requestId: "req-solo-fallback",
      timestamp: ts(300),
      provider: "gemini",
      model: "gemini-2.5-flash",
      proxy: { proxied: false, fallbackDirect: true, reason: "ECONNREFUSED" },
      tokens: { prompt_tokens: 40, completion_tokens: 15 },
      latencyMs: 450,
    });

    await db.saveRequestUsage({
      requestId: "req-solo-plain",
      timestamp: ts(400),
      provider: "groq",
      model: "llama-3.3-70b",
      tokens: { prompt_tokens: 30, completion_tokens: 5 },
      latencyMs: 110,
    });

    const assertRows = (rows) => {
      const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));

      expect(byModel["gpt-4.1"].combo).toBe("my-fast-combo");
      expect(byModel["gpt-4.1"].proxy).toMatchObject({ proxied: true, poolName: "VN-Residential", host: "http://10.2.3.4:8080" });

      expect(byModel["claude-sonnet-4"].combo).toBe("claude-combo");
      expect(byModel["claude-sonnet-4"].proxy).toBeUndefined();

      expect(byModel["gemini-2.5-flash"].combo).toBeUndefined();
      expect(byModel["gemini-2.5-flash"].proxy).toMatchObject({ proxied: false, fallbackDirect: true, reason: "ECONNREFUSED" });

      expect(byModel["llama-3.3-70b"].combo).toBeUndefined();
      expect(byModel["llama-3.3-70b"].proxy).toBeUndefined();
    };

    const stats = await db.getUsageStats("24h");
    assertRows(stats.recentRequests);

    const active = await db.getActiveRequests();
    assertRows(active.recentRequests);

    // Simulate server restart: clear in-memory ring and verify ensureRingInitialized() reloads combo + proxy from DB
    global._recentRing = { items: [], initialized: false };
    const afterRestart = await db.getActiveRequests();
    assertRows(afterRestart.recentRequests);
  });

  it("chatCore handlers and UsageStats UI wire proxy + combo cleanly", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const usageStatsSrc = fs.readFileSync(path.join(repoRoot, "src/shared/components/UsageStats.js"), "utf8");
    const chatSrc = fs.readFileSync(path.join(repoRoot, "src/sse/handlers/chat.js"), "utf8");
    const reqDetailSrc = fs.readFileSync(path.join(repoRoot, "open-sse/handlers/chatCore/requestDetail.js"), "utf8");

    expect(usageStatsSrc).toContain("ProxyBadge");
    expect(usageStatsSrc).toContain("ProxyFallbackBadge");
    expect(usageStatsSrc).toContain("ProxyBlockedBadge");
    expect(usageStatsSrc).toContain("r.combo");
    expect(chatSrc).toContain("comboName: modelStr");
    expect(reqDetailSrc).toContain("proxy = null, combo = null");
  });
});

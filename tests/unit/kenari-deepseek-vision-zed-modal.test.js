/**
 * Tests for two independent frontend/capabilities fixes:
 *
 * #4293 — deepseek-v4-1-flash (hyphen) has vision=false
 *   Kenari exposes the model under the ID "deepseek-v4-1-flash" (dash instead
 *   of dot).  The capabilities table only had "deepseek-v4.1-flash" (dot), so
 *   the hyphenated variant fell through to the generic *deepseek* pattern which
 *   has vision:false.  Fix: add "deepseek-v4-1-flash" as an alias with the same
 *   vision:true entry.
 *
 * #4244 — Zed missing from SelectModelModal LIVE_CATALOG_PROVIDERS
 *   The hardcoded list ["cursor","cline","clinepass"] omitted "zed", so the
 *   Zed provider card was never fetched and never shown in the Combo picker.
 *   Fix: add "zed" to the list (and wire up the corresponding state/hook/ternary).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// ── #4293 deepseek-v4-1-flash vision capability ───────────────────────────

describe("deepseek-v4-1-flash capabilities (#4293)", () => {
  it("reports vision:true for the hyphenated deepseek-v4-1-flash id (Kenari variant)", () => {
    // Any provider that uses the hyphenated id should get vision:true
    const caps = getCapabilitiesForModel("kenari", "deepseek-v4-1-flash");
    expect(caps.vision).toBe(true);
  });

  it("still reports vision:true for the dotted deepseek-v4.1-flash id", () => {
    const caps = getCapabilitiesForModel("ollama", "deepseek-v4.1-flash");
    expect(caps.vision).toBe(true);
  });

  it("still reports reasoning:true for deepseek-v4-1-flash", () => {
    const caps = getCapabilitiesForModel("kenari", "deepseek-v4-1-flash");
    expect(caps.reasoning).toBe(true);
  });

  it("reports the correct contextWindow (1M) for deepseek-v4-1-flash", () => {
    const caps = getCapabilitiesForModel("kenari", "deepseek-v4-1-flash");
    expect(caps.contextWindow).toBe(1000000);
  });
});

// ── #4244 live catalogs: every provider, not a hardcoded four ────────────
// The original fix added "zed" to a hardcoded LIVE_CATALOG_PROVIDERS list, which
// still left every other provider on the static registry while the provider page
// used the live catalog. The list is gone: the picker now asks each provider's
// own /models endpoint for its first active connection, so a provider can never
// be "missing from the list" again. These assertions pin that invariant.
// ModelSelectModal.js is JSX so we cannot import it in Vitest without a
// JSX transform; read the source text instead.

import fs from "fs";

describe("ModelSelectModal uses a live catalog for every provider (#4244)", () => {
  let src;
  beforeAll(() => {
    const fileUrl = new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url);
    src = fs.readFileSync(fileUrl, "utf-8");
  });

  it("no longer gates live catalogs behind a provider allowlist", () => {
    expect(src).not.toMatch(/LIVE_CATALOG_PROVIDERS/);
  });

  it("fetches each provider's own /models endpoint", () => {
    expect(src).toContain("/api/providers/${connectionId}/models");
  });

  it("reads the live catalog for every provider in the picker", () => {
    expect(src).toMatch(/const liveModels = liveCatalogs\[providerId\] \|\| \[\]/);
  });

  it("picks the first active connection, matching the provider page", () => {
    expect(src).toContain("firstConnectionByProvider");
  });
});

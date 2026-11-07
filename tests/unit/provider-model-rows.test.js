// Guards for two dashboard crashes reported from the provider page:
//  1. GET /providers/<custom-name>.png 404 — the icon chain guessed a bundled
//     mark for a provider id/name that was never bundled.
//  2. "Cannot read properties of undefined (reading 'localeCompare')" — a
//     live /models row without a display name reached the picker's sort.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeModelRows } from "../../src/shared/utils/modelRows.js";
import { getModelKind } from "../../src/shared/constants/models.js";
import {
  getBrandIconSrc,
  getNameIconSrc,
  getProviderIconSrc,
  getTypeBrandIconSrc,
} from "../../src/shared/utils/providerIcon.js";
import { PROVIDER_ICON_IDS } from "../../src/shared/utils/providerIconManifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const read = (relPath) => readFileSync(join(repoRoot, relPath), "utf8");

describe("provider icon manifest", () => {
  it("lists exactly the bundled marks under public/providers", () => {
    const bundled = readdirSync(join(repoRoot, "public", "providers"))
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .map((name) => name.slice(0, -4).toLowerCase())
      .sort();
    expect([...PROVIDER_ICON_IDS].sort()).toEqual(bundled);
  });

  it("never requests a bundled mark that does not exist", () => {
    // Custom provider ids/names from a live install: no file, so no request.
    expect(getProviderIconSrc("vilao")).toBeNull();
    expect(getProviderIconSrc("ViLao")).toBeNull();
    expect(getProviderIconSrc("thanhpkt36")).toBeNull();
    expect(getProviderIconSrc("openai-compatible-chat-6c7d1afb-fcf1-4d3e-bf32-e491b66e2bbc")).toBeNull();
    expect(getNameIconSrc("ViLao")).toBeNull();
    expect(getNameIconSrc("thanhpkt36")).toBeNull();
  });

  it("still resolves the bundled marks and their aliases", () => {
    expect(getProviderIconSrc("deepseek")).toBe("/providers/deepseek.png");
    expect(getProviderIconSrc("opencode-zen")).toBe("/providers/opencode.png");
    expect(getNameIconSrc("DeepSeek")).toBe("/providers/deepseek.png");
    expect(getBrandIconSrc("https://api.openai.com/v1")).toBe("/providers/openai.png");
    expect(getTypeBrandIconSrc("openai-compatible")).toBe("/providers/openai.png");
    expect(getTypeBrandIconSrc("anthropic-compatible")).toBe("/providers/anthropic.png");
  });
});

describe("normalizeModelRows", () => {
  it("gives OpenAI-shaped rows (no name) their id as the display name", () => {
    expect(normalizeModelRows([{ id: "deepseek-chat", object: "model", owned_by: "deepseek" }]))
      .toEqual([{ id: "deepseek-chat", object: "model", owned_by: "deepseek", name: "deepseek-chat" }]);
  });

  it("keeps real display names and accepts snake/camel variants", () => {
    expect(normalizeModelRows([
      { id: "a", name: "Alpha" },
      { id: "b", display_name: "Bravo" },
      { id: "c", displayName: "Charlie" },
    ]).map((m) => m.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("handles bare id strings and drops rows without an id", () => {
    expect(normalizeModelRows(["m1", null, {}, { name: "" }, 42])).toEqual([{ id: "m1", name: "m1" }]);
  });

  it("is safe on a non-array payload", () => {
    expect(normalizeModelRows(undefined)).toEqual([]);
    expect(normalizeModelRows(null)).toEqual([]);
    expect(normalizeModelRows({ data: [] })).toEqual([]);
  });

  it("never leaves a row without a string name (the localeCompare crash)", () => {
    for (const row of normalizeModelRows([{ id: "x" }, "y", { model: "z" }])) {
      expect(typeof row.name).toBe("string");
      expect(row.name.length).toBeGreaterThan(0);
    }
  });
});

describe("model pickers sort on a safe label", () => {
  it("ModelSelectModal sorts with a name/value/id fallback", () => {
    const source = read("src/shared/components/ModelSelectModal.js");
    expect(source).toMatch(/const label = \(model\) => String\(model\?\.name \|\| model\?\.value \|\| model\?\.id \|\| ""\)/);
    expect(source).not.toMatch(/\.sort\(\(a, b\) => a\.name\.localeCompare\(b\.name\)\)/);
    expect(source).toContain("normalizeModelRows(data.models)");
  });

  it("a compatible node offers the same catalog its provider page lists", () => {
    const source = read("src/shared/components/ModelSelectModal.js");
    expect(source).toContain("const liveNodeModels = (liveCatalogs[providerId] || []).map((m) => ({");
    expect(source).toContain("...allowModels, ...liveNodeModels, ...nodeModels, ...registeredCustom");
  });

  it("BasicChat model list sorts with a fallback too", () => {
    const source = read("src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js");
    expect(source).not.toMatch(/sort\(\(a, b\) => a\.name\.localeCompare\(b\.name\)\)/);
    expect(source).toContain('String(a.name || a.id || "").localeCompare(String(b.name || b.id || ""))');
  });

  it("the provider models route normalizes every payload it returns", () => {
    const source = read("src/app/api/providers/[id]/models/route.js");
    expect(source).toContain("normalizeModelRows");
    // Every resolver funnels through one responder, which normalizes first.
    expect(source).toContain("const normalized = normalizeModels(models);");
    expect(source).toContain("return remember(models);");
    expect(source).toContain("return remember(result.models, { warning: result.warning });");
    expect(source).toContain("return remember(staticModels, {");
  });
});

describe("loaded catalogs are stored in the DB, not re-fetched on every view", () => {
  const route = read("src/app/api/providers/[id]/models/route.js");
  const page = read("src/app/(dashboard)/dashboard/providers/[id]/page.js");

  it("serves the stored catalog before any upstream resolver runs", () => {
    expect(route).toContain("getLoadedModels");
    const storedIdx = route.indexOf("const saved = await getLoadedModels(cacheKey)");
    const upstreamIdx = route.indexOf("if (isOpenAICompatibleProvider(connection.provider) ||");
    expect(storedIdx).toBeGreaterThan(-1);
    expect(upstreamIdx).toBeGreaterThan(storedIdx);
  });

  it("only an explicit refresh hits the provider again", () => {
    expect(route).toContain('searchParams.get("refresh") === "1"');
    expect(route).toContain("setLoadedModels(cacheKey");
    // The Load button and the qoder/cline importers are the refresh paths.
    expect(page).toContain("/models?refresh=1");
    expect(page.match(/\?refresh=1/g) || []).toHaveLength(4);
  });

  it("keeps the stored catalog when a refresh fails", () => {
    expect(route).toContain("stale: true");
  });

  it("has a repo that persists the catalog under its own scope", () => {
    const repo = read("src/lib/db/repos/loadedModelsRepo.js");
    expect(repo).toContain('makeKv("loadedModels")');
    expect(repo).toContain("export async function setLoadedModels");
  });
});

describe("custom model rows obey the denylist", () => {
  const page = read("src/app/(dashboard)/dashboard/providers/[id]/page.js");

  it("removes a disabled custom row from the list and surfaces it in Disabled models", () => {
    // Custom rows were rendered straight from the custom-model table, so the
    // X wrote to the denylist and the chip never moved.
    expect(page).toContain(".filter((row) => !disabledSet.has(row.id))");
    expect(page).toContain(".filter((row) => disabledSet.has(row.id))");
  });

  it("keeps the disabled list de-duplicated against the catalog", () => {
    expect(page).toContain("...allModels.filter((m) => disabledSet.has(m.id) && !customRowIds.has(m.id))");
  });
});

describe("model kind", () => {
  it("treats upstream chat types as LLM so the catalog is not filtered away", () => {
    // OpenAI-compatible catalogs (e.g. api.cencori.com) tag every row
    // `type: "chat"`. Comparing that to "llm" hid all 101 loaded models.
    expect(getModelKind({ type: "chat" })).toBe("llm");
    expect(getModelKind({ type: "text" })).toBe("llm");
    expect(getModelKind({ type: "completion" })).toBe("llm");
    expect(getModelKind({ kind: "llm" })).toBe("llm");
    expect(getModelKind({}, "llm")).toBe("llm");
  });

  it("keeps real media kinds untouched", () => {
    expect(getModelKind({ type: "image" })).toBe("image");
    expect(getModelKind({ kind: "tts" })).toBe("tts");
    expect(getModelKind({ type: "embedding" })).toBe("embedding");
    expect(getModelKind({})).toBeNull();
  });
});

describe("provider model section is one list under the toolbar", () => {
  it("renders the merged list instead of a separate custom block", () => {
    const source = read("src/app/(dashboard)/dashboard/providers/[id]/page.js");
    expect(source).toContain("const displayModels = [");
    expect(source).toContain("{displayModels.map((m) => (");
    // The old split: custom rows rendered above the action row.
    expect(source).not.toContain("{customModelRows.filter(matchSearch).map((model) => (");
    expect(source).not.toContain("{loadedDisplayModels.filter(matchSearch).map((m) => {");
  });
});

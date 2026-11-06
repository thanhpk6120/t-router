import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isModelDisabled, filterActiveComboModels } from "../../src/sse/services/model.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const read = (relPath) => readFileSync(join(repoRoot, relPath), "utf8");

describe("isModelDisabled", () => {
  const disabledByAlias = {
    ag: ["claude-opus-5-5-high", "gemini-3.8-flash"],
    oc: ["mimo-v2.6-flash-free"],
    "openai-compatible-chat-custom1": ["custom-model-x"],
  };

  it("detects disabled models by providerAlias/modelId", async () => {
    expect(await isModelDisabled("ag/claude-opus-5-5-high", { disabledByAlias })).toBe(true);
    expect(await isModelDisabled("ag/gemini-3.8-flash", { disabledByAlias })).toBe(true);
    expect(await isModelDisabled("oc/mimo-v2.6-flash-free", { disabledByAlias })).toBe(true);
    expect(await isModelDisabled("openai-compatible-chat-custom1/custom-model-x", { disabledByAlias })).toBe(true);
  });

  it("detects disabled models via full providerId", async () => {
    // antigravity aliases to ag
    expect(await isModelDisabled("antigravity/claude-opus-5-5-high", { disabledByAlias })).toBe(true);
  });

  it("returns false for enabled models", async () => {
    expect(await isModelDisabled("ag/claude-sonnet-5", { disabledByAlias })).toBe(false);
    expect(await isModelDisabled("oc/glm-4.7-flash", { disabledByAlias })).toBe(false);
    expect(await isModelDisabled("cx/gpt-6.1-sol", { disabledByAlias })).toBe(false);
  });

  it("detects disabled variant whose backing model is disabled", async () => {
    const variants = {
      "fast-opus": { model: "ag/claude-opus-5-5-high" },
      "fast-sonnet": { model: "ag/claude-sonnet-5" },
    };
    expect(await isModelDisabled("fast-opus", { disabledByAlias, variants })).toBe(true);
    expect(await isModelDisabled("fast-sonnet", { disabledByAlias, variants })).toBe(false);
  });

  it("detects disabled combo when all members are disabled", async () => {
    const combosByName = new Map([
      ["dead-combo", { models: ["ag/claude-opus-5-5-high", "oc/mimo-v2.6-flash-free"] }],
      ["mixed-combo", { models: ["ag/claude-opus-5-5-high", "ag/claude-sonnet-5"] }],
    ]);
    expect(await isModelDisabled("dead-combo", { disabledByAlias, combosByName })).toBe(true);
    expect(await isModelDisabled("mixed-combo", { disabledByAlias, combosByName })).toBe(false);
  });
});

describe("filterActiveComboModels", () => {
  const disabledByAlias = {
    ag: ["claude-opus-5-5-high"],
    cx: ["broken-model"],
  };

  it("filters out disabled members while preserving active ones in order", async () => {
    const input = ["ag/claude-opus-5-5-high", "ag/claude-sonnet-5", "cx/broken-model", "cx/gpt-6.1-sol"];
    const filtered = await filterActiveComboModels(input, { disabledByAlias });
    expect(filtered).toEqual(["ag/claude-sonnet-5", "cx/gpt-6.1-sol"]);
  });

  it("returns empty array if all members are disabled", async () => {
    const input = ["ag/claude-opus-5-5-high", "cx/broken-model"];
    const filtered = await filterActiveComboModels(input, { disabledByAlias });
    expect(filtered).toEqual([]);
  });
});

describe("Static guards for disabled model handling across routes", () => {
  it("chat handler blocks disabled models and respects x-allow-disabled", () => {
    const chat = read("src/sse/handlers/chat.js");
    expect(chat).toContain('isModelDisabled(modelStr)');
    expect(chat).toContain('clientRawRequest?.headers?.["x-allow-disabled"] === "1"');
    expect(chat).toContain('errorResponse(HTTP_STATUS.NOT_FOUND, `Model "${modelStr}" is disabled`)');
  });

  it("combo dispatch filters activeComboModels and rejects if all disabled", () => {
    const combo = read("src/sse/services/comboDispatch.js");
    expect(combo).toContain("filterActiveComboModels(comboModels)");
    expect(combo).toContain('All models in combo "${comboName}" are disabled');
    expect(combo).toContain("filterActiveComboModels(augmentedModels)");
  });

  it("v1/models excludes disabled models, variants with disabled targets, and fully disabled combos", () => {
    const route = read("src/app/api/v1/models/route.js");
    expect(route).toContain("isModelDisabled(m, { disabledByAlias, combosByName })");
    expect(route).toContain("isModelDisabled(entry.model, { disabledByAlias })");
    expect(route).toContain("isModelDisabled(`${outputAlias}/${modelId}`, { disabledByAlias })");
  });

  it("v1/models/info returns 404 for disabled models", () => {
    const info = read("src/app/api/v1/models/info/route.js");
    expect(info).toContain("isModelDisabled(id)");
    expect(info).toContain('status: 404');
  });

  it("api/models filters customModels when !includeDisabled", () => {
    const modelsRoute = read("src/app/api/models/route.js");
    expect(modelsRoute).toContain("if (!includeDisabled)");
    expect(modelsRoute).toContain("aliasList.includes(m.id)");
  });

  it("UsageStats splits panels equally 50/50 and gives full width to model column", () => {
    const stats = read("src/shared/components/UsageStats.js");
    expect(stats).toContain("lg:grid-cols-2");
    expect(stats).not.toContain("lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]");
    expect(stats).toContain("max-w-0 w-full");
  });
});

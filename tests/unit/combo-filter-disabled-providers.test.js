import { describe, it, expect, vi } from "vitest";
import { filterActiveComboModels } from "../../src/sse/services/model.js";

describe("filterActiveComboModels with provider and account disable status", () => {
  const connections = [
    { id: "conn-1", provider: "openai", isActive: true },
    { id: "conn-2", provider: "anthropic", isActive: false },
    { id: "conn-3", provider: "anthropic", isActive: 0 },
    { id: "conn-4", provider: "deepseek", isActive: true },
  ];

  const settings = {
    providerStrategies: {
      deepseek: { disabled: true },
    },
  };

  it("filters out models whose provider is disabled in settings", async () => {
    const models = ["openai/gpt-4o", "deepseek/deepseek-chat"];
    const active = await filterActiveComboModels(models, { settings, connections });
    expect(active).toEqual(["openai/gpt-4o"]);
  });

  it("filters out models whose provider has all accounts disabled", async () => {
    const models = ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"];
    const active = await filterActiveComboModels(models, { settings, connections });
    expect(active).toEqual(["openai/gpt-4o"]);
  });

  it("returns empty array when all models in combo belong to disabled providers or accounts", async () => {
    const models = ["deepseek/deepseek-chat", "anthropic/claude-3-5-sonnet"];
    const active = await filterActiveComboModels(models, { settings, connections });
    expect(active).toEqual([]);
  });

  it("keeps noAuth free providers even without DB connections unless explicitly disabled", async () => {
    const models = ["opencode/deepseek-chat", "openai/gpt-4o"];
    const active = await filterActiveComboModels(models, { settings, connections });
    expect(active).toContain("opencode/deepseek-chat");
    expect(active).toContain("openai/gpt-4o");
  });
});

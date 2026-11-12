import { describe, it, expect } from "vitest";
import { buildModelGroups, filterDisabledModels } from "../../src/shared/utils/selectableModels.js";

const COMPAT = "anthropic-compatible-2c95b9e1-b819-4b71-9edd-5268b5f00f5d";
const conn = (provider, extra = {}) => ({ id: "c-" + provider, provider, isActive: true, providerSpecificData: {}, ...extra });

describe("model picker — disabled models never appear", () => {
  it("drops disabled custom rows of a compatible provider", () => {
    const groups = buildModelGroups({
      connections: [conn(COMPAT)],
      allConnections: [conn(COMPAT)],
      customModels: [
        { providerAlias: COMPAT, id: "deepseek-v4-pro", name: "deepseek-v4-pro", type: "llm" },
        { providerAlias: COMPAT, id: "deepseek-v4-pro-thinking", name: "deepseek-v4-pro-thinking", type: "llm" },
        { providerAlias: COMPAT, id: "kept-model", name: "kept-model", type: "llm" },
      ],
      disabledModels: { [COMPAT]: ["deepseek-v4-pro", "deepseek-v4-pro-thinking"] },
    });
    const ids = (groups[COMPAT]?.models || []).map((m) => m.id);
    expect(ids).toEqual(["kept-model"]);
  });

  it("matches a denylist entry stored as the full alias/model value", () => {
    const groups = {
      [COMPAT]: {
        alias: COMPAT,
        models: [
          { id: "a", name: "a", value: COMPAT + "/a" },
          { id: "b", name: "b", value: COMPAT + "/b" },
        ],
      },
    };
    filterDisabledModels(groups, { [COMPAT]: [COMPAT + "/a"] });
    expect(groups[COMPAT].models.map((m) => m.id)).toEqual(["b"]);
  });

  it("matches a denylist keyed by the provider display alias", () => {
    const groups = {
      [COMPAT]: {
        alias: "TraderDz12",
        models: [
          { id: "a", name: "a", value: "TraderDz12/a" },
          { id: "b", name: "b", value: "TraderDz12/b" },
        ],
      },
    };
    filterDisabledModels(groups, { TraderDz12: ["a"] });
    expect(groups[COMPAT].models.map((m) => m.id)).toEqual(["b"]);
  });

  it("deletes a provider group once every model is disabled", () => {
    const groups = { [COMPAT]: { alias: COMPAT, models: [{ id: "a", name: "a" }] } };
    filterDisabledModels(groups, { [COMPAT]: ["a"] });
    expect(groups[COMPAT]).toBeUndefined();
  });
});

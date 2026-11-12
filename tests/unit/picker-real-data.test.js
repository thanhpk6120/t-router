import { describe, it, expect } from "vitest";
import { buildModelGroups } from "../../src/shared/utils/selectableModels.js";

// Row shapes taken from the live server DB (kv scope customModels/disabledModels)
// for provider "TraderDz12" — the case in the bug report.
const COMPAT = "anthropic-compatible-2c95b9e1-b819-4b71-9edd-5268b5f00f5d";

describe("picker with live server rows", () => {
  it("hides both disabled custom rows and keeps nothing else", () => {
    const conn = { id: "c1", provider: COMPAT, isActive: true, providerSpecificData: {} };
    const groups = buildModelGroups({
      connections: [conn],
      allConnections: [conn],
      customModels: [
        { providerAlias: COMPAT, id: "deepseek-v4-pro-thinking", type: "llm", name: "deepseek-v4-pro-thinking" },
        { providerAlias: COMPAT, id: "deepseek-v4-pro", type: "llm", name: "deepseek-v4-pro" },
      ],
      disabledModels: { [COMPAT]: ["deepseek-v4-pro", "deepseek-v4-pro-thinking"] },
    });
    expect(groups[COMPAT]).toBeUndefined();
  });
});

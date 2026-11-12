import { describe, it, expect } from "vitest";
import { getModelKind } from "../../src/shared/constants/models.js";

// Exact rows from the server DB (kv loadedModels,
// connection 5216236f-19ff-48df-a40f-4aa254a84f74): an Anthropic-compatible
// provider whose catalog answers { id, display_name, type: "model" }.
const CATALOG = [
  { id: "auto", created_at: "2021-07-20T10:40:00Z", display_name: "auto", type: "model", name: "auto" },
  { id: "DeepSeek-V4.1-Flash", type: "model", name: "DeepSeek-V4.1-Flash" },
  { id: "glm-5.3", type: "model", name: "glm-5.3" },
  { id: "kimi-k3", type: "model", name: "kimi-k3" },
];

// The provider detail page keeps a row when it has no kind or the LLM kind
// (see renderModelsSection: `!k || k === "llm"`).
const visibleOnProviderPage = (rows) =>
  rows.filter((m) => { const k = getModelKind(m); return !k || k === "llm"; });

describe("provider page — a loaded catalog is actually listed", () => {
  it("does not filter out rows whose upstream type is the object kind \"model\"", () => {
    expect(visibleOnProviderPage(CATALOG).map((m) => m.id))
      .toEqual(["auto", "DeepSeek-V4.1-Flash", "glm-5.3", "kimi-k3"]);
  });

  it("still hides real media rows", () => {
    const rows = [{ id: "txt-embed", type: "embedding" }, { id: "chat-a", type: "model" }];
    expect(visibleOnProviderPage(rows).map((m) => m.id)).toEqual(["chat-a"]);
  });
});

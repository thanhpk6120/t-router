import { describe, it, expect } from "vitest";
import { getModelKind } from "../../src/shared/constants/models.js";

describe("getModelKind — upstream row object kinds", () => {
  it("treats an Anthropic-style { type: \"model\" } row as an LLM", () => {
    expect(getModelKind({ id: "auto", display_name: "auto", type: "model" })).toBe("llm");
  });

  it("treats OpenAI object kinds as an LLM", () => {
    for (const type of ["chat", "text", "completion", "responses", "model"]) {
      expect(getModelKind({ type })).toBe("llm");
    }
  });

  it("keeps a genuine non-LLM kind untouched", () => {
    expect(getModelKind({ type: "embedding" })).toBe("embedding");
    expect(getModelKind({ type: "image" })).toBe("image");
  });
});

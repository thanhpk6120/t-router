// OpenCode Go's claude-haiku-5-5 rejects the budget-shaped thinking that older
// *claude*haiku* capability patterns emit:
//   400 "thinking.type.enabled" is not supported for this model.
//       Use "thinking.type.adaptive" and "output_config.effort" to control thinking
// Two layers cover it, both landing on claude-adaptive:
//   - the exact global entry (capabilities.js MODEL_CAPABILITIES["claude-haiku-5-5"]),
//     added in f3bb7d1 because Anthropic's own API rejects the budget shape for 5.5 too;
//   - the opencode-go claude transport declares thinkingFormat: "claude-adaptive",
//     which wins over the model entry for every model on that wire (resolveFormat).
// These tests drive the real applyThinking() so a regression in either layer shows
// up as the old shape again.
import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// A Claude-wire request asking for thinking on (what Claude Code sends).
const claudeWireBody = (model = "claude-haiku-5-5") => ({
  model,
  max_tokens: 4096,
  thinking: { type: "enabled", budget_tokens: 8000 },
  messages: [{ role: "user", content: "hi" }],
});

describe("opencode-go claude-haiku-5-5 thinking shape", () => {
  it("resolves claude-adaptive for this id with or without a provider", () => {
    // Exact global entry: Anthropic's API rejects the budget shape for 5.5 itself,
    // so the id is adaptive everywhere, not only behind opencode-go.
    expect(getCapabilitiesForModel(undefined, "claude-haiku-5-5").thinkingFormat).toBe("claude-adaptive");
    expect(getCapabilitiesForModel("opencode-go", "claude-haiku-5-5").thinkingFormat).toBe("claude-adaptive");
  });

  it("emits thinking.type=adaptive + output_config.effort (never type=enabled)", () => {
    const body = applyThinking("claude", "claude-haiku-5-5", claudeWireBody(), "opencode-go");

    expect(body.thinking?.type).toBe("adaptive");
    expect(body.thinking).not.toHaveProperty("budget_tokens");
    expect(body.output_config?.effort).toBeTruthy();
  });

  it("the transport override stays scoped: another provider keeps the budget shape", () => {
    // Regression guard: PROVIDERS["opencode-go"].transports[].thinkingFormat must not
    // leak past opencode-go. claude-haiku-4-5 is still budget-shaped globally, so a
    // plain Anthropic request keeps type=enabled while opencode-go's claude wire flips
    // it to adaptive.
    const direct = applyThinking("claude", "claude-haiku-4-5", claudeWireBody("claude-haiku-4-5"), "claude");
    expect(direct.thinking?.type).toBe("enabled");
    expect(direct.thinking?.budget_tokens).toBeGreaterThan(0);
    expect(direct.output_config).toBeUndefined();

    const viaGo = applyThinking("claude", "claude-haiku-4-5", claudeWireBody("claude-haiku-4-5"), "opencode-go");
    expect(viaGo.thinking?.type).toBe("adaptive");
  });
});

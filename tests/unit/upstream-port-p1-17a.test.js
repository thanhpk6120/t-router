// P1-17 (part 1): upstream 0.5.111/0.5.112 safe ports — Codex image shim,
// new catalog rows, capability entries, CommandCode headers identity,
// and reasoning_effort max on OpenAI-compatible nodes.
// Run from tests/:
//   bun x vitest run unit/upstream-port-p1-17a.test.js
import { describe, it, expect } from "vitest";
import codexImageProvider from "../../open-sse/handlers/imageProviders/codex.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import codexRegistry from "../../open-sse/providers/registry/codex.js";
import commandcodeRegistry from "../../open-sse/providers/registry/commandcode.js";

describe("Codex image shim (gpt-6-sol-image supersedes gpt-5.6-*-image)", () => {
  // resolveCodexImageModels is module-private; drive the public buildBody and read the
  // model the request actually goes out with. f3bb7d1 dropped the three gpt-5.6-*-image
  // virtual ids, so gpt-6-sol-image is now the only *-image virtual model — its suffix
  // strips to the gpt-6-sol Responses host.
  it("maps the *-image virtual id to the gpt-6-sol host", () => {
    const body = codexImageProvider.buildBody(
      "gpt-6-sol-image",
      { prompt: "a green square", size: "1024x1024", output_format: "png" }
    );
    expect(body.model).toBe("gpt-6-sol");
    expect(body.tools).toEqual([{ type: "image_generation", output_format: "png", size: "1024x1024" }]);
    expect(body.tool_choice).toBe("auto");
  });

  it("keeps GPT Image tool models on the gpt-6-sol host with a tool model pinned", () => {
    const body = codexImageProvider.buildBody(
      "gpt-image-2.5",
      { prompt: "a green square", size: "1024x1024", output_format: "png" }
    );
    expect(body.model).toBe("gpt-6-sol");
    expect(body.tools[0].model).toBe("gpt-image-2.5");
    expect(body.tool_choice).toEqual({ type: "image_generation" });
  });

  it("registry lists gpt-6-sol-image and no longer carries the dropped 5.6 ids", () => {
    const ids = new Set(codexRegistry.models.map((m) => m.id));
    expect(ids.has("gpt-6-sol-image")).toBe(true);
    expect(ids.has("gpt-6.1-terra")).toBe(true);
    for (const dropped of ["gpt-5.6-sol-image", "gpt-5.6-terra-image", "gpt-5.6-luna-image"]) {
      expect(ids.has(dropped)).toBe(false);
    }
  });

  it("caps mark the surviving image id and the new chat model", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6-sol-image").imageOutput).toBe(true);
    expect(getCapabilitiesForModel("codex", "gpt-6.1-terra").contextWindow).toBe(500000);
  });
});

describe("upstream catalog / caps ports", () => {
  it("kimi-k3.1-pro, deepseek free cap", () => {
    expect(getCapabilitiesForModel(null, "kimi-k3.1-pro").contextWindow).toBe(1048576);
    expect(getCapabilitiesForModel("opencode", "deepseek-v4.1-flash-free").contextWindow).toBe(330000);
  });

  it("CommandCode registry carries the CLI identity headers and Kimi K3.1 Pro", () => {
    // Assert the shape, not a frozen patch number: the CLI ships often and the registry
    // is the single source for it (command-code@1.88.5 at the time of writing).
    expect(commandcodeRegistry.transport.headers["x-command-code-version"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(commandcodeRegistry.transport.headers["x-cli-surface"]).toBe("cli");
    expect(commandcodeRegistry.models.some((m) => m.id === "moonshotai/Kimi-K3.1-Pro")).toBe(true);
  });

  it("OpenAI-compatible nodes keep reasoning_effort max for GPT-5.6/6", () => {
    expect(getThinkingLevels("openai-compatible-foo", "gpt-6-sol")).toContain("max");
    expect(getThinkingLevels("openai-compatible-foo", "gpt-5.6-sol")).toContain("max");
  });
});

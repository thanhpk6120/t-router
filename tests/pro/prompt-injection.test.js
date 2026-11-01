// T Router — Prompt Injection + injector tests (vitest, upstream harness).
// Run from tests/: npx vitest run pro/prompt-injection.test.js
import assert from "node:assert";
import { injectSystemPrompt, injectChatTurns } from "open-sse/rtk/systemInject.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { selectPromptInjections, cleanTemplate, cleanRule } from "@/lib/db/repos/promptInjectRepo.js";

describe("injectSystemPrompt — OpenAI chat", () => {
  it("append goes after existing system text", () => {
    const body = { messages: [{ role: "system", content: "BASE" }, { role: "user", content: "hi" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, "APPENDED", "append");
    assert.equal(body.messages[0].content, "BASE\n\nAPPENDED");
  });

  it("prepend goes before existing system text", () => {
    const body = { messages: [{ role: "system", content: "BASE" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, "FRONT", "prepend");
    assert.equal(body.messages[0].content, "FRONT\n\nBASE");
  });

  it("is idempotent", () => {
    const body = { messages: [{ role: "system", content: "BASE" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, "X", "append");
    injectSystemPrompt(body, FORMATS.OPENAI, "X", "append");
    assert.equal(body.messages[0].content, "BASE\n\nX");
  });
});

describe("injectChatTurns — messages[]", () => {
  const TURNS = [
    { role: "user", content: "The codename is BANANA-42." },
    { role: "assistant", content: "Noted: BANANA-42." },
  ];

  it("inserts after the leading system message, before the real chat", () => {
    const body = { messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "What is the codename?" },
    ]};
    injectChatTurns(body, FORMATS.OPENAI, TURNS);
    assert.deepEqual(body.messages.map(m => m.role), ["system", "user", "assistant", "user"]);
    assert.equal(body.messages[1].content, "The codename is BANANA-42.");
    assert.equal(body.messages[3].content, "What is the codename?");
  });

  it("inserts at index 0 when there is no system message (Claude shape)", () => {
    const body = { system: "SYS", messages: [{ role: "user", content: "hi" }] };
    injectChatTurns(body, FORMATS.CLAUDE, TURNS);
    assert.deepEqual(body.messages.map(m => m.role), ["user", "assistant", "user"]);
  });

  it("merges when the block ends with the role the real chat starts with", () => {
    const body = { messages: [{ role: "user", content: "real question" }] };
    injectChatTurns(body, FORMATS.OPENAI, [{ role: "user", content: "priming" }]);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, "priming\n\nreal question");
  });

  it("is idempotent", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectChatTurns(body, FORMATS.OPENAI, TURNS);
    injectChatTurns(body, FORMATS.OPENAI, TURNS);
    assert.equal(body.messages.length, 3);
  });

  it("drops empty/invalid turns and no-ops on empty input", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectChatTurns(body, FORMATS.OPENAI, [{ role: "user", content: "  " }, { role: "system", content: "x" }]);
    assert.equal(body.messages.length, 1);
    injectChatTurns(body, FORMATS.OPENAI, []);
    assert.equal(body.messages.length, 1);
  });
});

describe("injectChatTurns — Gemini contents[]", () => {
  it("maps assistant → model and inserts at the head", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    injectChatTurns(body, FORMATS.GEMINI, [
      { role: "user", content: "U1" },
      { role: "assistant", content: "A1" },
    ]);
    assert.deepEqual(body.contents.map(c => c.role), ["user", "model", "user"]);
    assert.equal(body.contents[1].parts[0].text, "A1");
  });
});

describe("injectChatTurns — Responses input[]", () => {
  it("inserts message items after system items with typed content", () => {
    const body = { input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "SYS" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]};
    injectChatTurns(body, FORMATS.OPENAI, [
      { role: "user", content: "U1" },
      { role: "assistant", content: "A1" },
    ]);
    assert.equal(body.input.length, 4);
    assert.equal(body.input[1].content[0].text, "U1");
    assert.equal(body.input[2].content[0].type, "output_text");
  });
});

describe("selectPromptInjections", () => {
  const single = (content, extra = {}) => ({ content, position: "append", enabled: true, ...extra });
  const chat = (turns, extra = {}) => ({ mode: "chat", turns, position: "append", enabled: true, ...extra });

  it("stacks global → user → model, singles carry text", () => {
    const out = selectPromptInjections(
      {
        global: single("G"),
        byKey: { k1: single("U") },
        byModel: { "prov/mycombo": single("M") },
      },
      { apiKeyId: "k1", resolvedModel: "prov/mycombo" }
    );
    assert.deepEqual(out.map(p => p.text), ["G", "U", "M"]);
    assert.ok(out.every(p => p.mode === "single"));
  });

  it("model+key is the most specific scope and stacks last", () => {
    const out = selectPromptInjections(
      {
        global: single("G"),
        byKey: { k1: single("U") },
        byModel: { "prov/mycombo": single("M") },
        byKeyModel: { k1: { "prov/mycombo": single("KM") } },
      },
      { apiKeyId: "k1", resolvedModel: "prov/mycombo" }
    );
    assert.deepEqual(out.map(p => p.text), ["G", "U", "M", "KM"]);
  });

  it("model+key fires only when BOTH the key and the model match", () => {
    const data = {
      global: null,
      byKey: {},
      byModel: {},
      byKeyModel: { k1: { "prov/mycombo": single("KM") } },
    };
    assert.deepEqual(
      selectPromptInjections(data, { apiKeyId: "other", resolvedModel: "prov/mycombo" }),
      []
    );
    assert.deepEqual(
      selectPromptInjections(data, { apiKeyId: "k1", resolvedModel: "prov/othermodel" }),
      []
    );
    assert.deepEqual(
      selectPromptInjections(data, { resolvedModel: "prov/mycombo" }),
      []
    );
    // Resolved provider/model hit inside the scope too.
    const out = selectPromptInjections(
      { ...data, byKeyModel: { k1: { "prov/mod": single("KM") } } },
      { apiKeyId: "k1", requestedModel: "alias", resolvedModel: "prov/mod", bareModel: "mod" }
    );
    assert.deepEqual(out.map(p => p.text), ["KM"]);
  });

  it("chat entries carry turns, not text", () => {
    const turns = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
    const out = selectPromptInjections(
      { global: chat(turns), byKey: {}, byModel: {} },
      {}
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].mode, "chat");
    assert.deepEqual(out[0].turns, turns);
  });

  it("legacy content-only entries (no mode) resolve as single", () => {
    const out = selectPromptInjections(
      { global: { content: "OLD", enabled: true }, byKey: {}, byModel: {} },
      {}
    );
    assert.equal(out[0].mode, "single");
    assert.equal(out[0].text, "OLD");
  });

  it("skips disabled and empty entries; chat with no valid turns is dropped", () => {
    const out = selectPromptInjections(
      {
        global: single("G", { enabled: false }),
        byKey: { k1: chat([{ role: "user", content: "  " }]) },
        byModel: { "prov/m": single("M") },
      },
      { apiKeyId: "k1", resolvedModel: "prov/m" }
    );
    assert.deepEqual(out.map(p => p.name), ["prov/m"]);
  });

  it("only the resolved provider/model matches; combo and bare names never match", () => {
    const out = selectPromptInjections(
      {
        global: null,
        byKey: {},
        byModel: { alias: single("ALIAS"), "prov/mod": single("RESOLVED"), mod: single("BARE") },
      },
      { requestedModel: "alias", resolvedModel: "prov/mod", bareModel: "mod" }
    );
    assert.equal(out[0].text, "RESOLVED");
    // No resolved hit → nothing, even though combo and bare entries exist.
    assert.deepEqual(
      selectPromptInjections(
        {
          global: null,
          byKey: {},
          byModel: { alias: single("ALIAS"), mod: single("BARE") },
        },
        { requestedModel: "alias", resolvedModel: "prov/other", bareModel: "mod" }
      ),
      []
    );
  });

  it("templates are library-only: legacy targets are dropped, prompt survives", () => {
    const cleaned = cleanTemplate({
      id: "x1",
      name: "Legacy",
      mode: "single",
      content: "L",
      position: "prepend",
      enabled: true,
      targets: { global: true, models: ["mod"], keys: ["k1"] },
    });
    assert.equal(cleaned.name, "Legacy");
    assert.equal(cleaned.content, "L");
    assert.equal("targets" in cleaned, false);
    // A nameless or empty template is rejected.
    assert.equal(cleanTemplate({ id: "x", name: " ", content: "L" }), null);
    assert.equal(cleanTemplate({ id: "x", name: "N", content: "  " }), null);
  });

  it("rules: matches multiple models and multiple API keys with wildcard support", () => {
    const rules = [
      {
        id: "r1",
        name: "Multi-Model Rule",
        enabled: true,
        mode: "single",
        content: "FOR_MODELS",
        position: "prepend",
        models: ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
        apiKeys: ["*"],
      },
      {
        id: "r2",
        name: "Multi-Key Rule",
        enabled: true,
        mode: "single",
        content: "FOR_KEYS",
        position: "append",
        models: ["*"],
        apiKeys: ["key_a", "key_b"],
      },
    ];

    // Matches r1 (model in list, wildcard key)
    const out1 = selectPromptInjections({ rules }, { apiKeyId: "key_c", resolvedModel: "openai/gpt-4o" });
    assert.deepEqual(out1.map((p) => p.text), ["FOR_MODELS"]);

    // Matches r2 (wildcard model, key in list)
    const out2 = selectPromptInjections({ rules }, { apiKeyId: "key_a", resolvedModel: "other/model" });
    assert.deepEqual(out2.map((p) => p.text), ["FOR_KEYS"]);

    // Matches both r1 and r2
    const outBoth = selectPromptInjections({ rules }, { apiKeyId: "key_b", resolvedModel: "anthropic/claude-3-5-sonnet" });
    assert.deepEqual(outBoth.map((p) => p.text), ["FOR_MODELS", "FOR_KEYS"]);

    // Matches neither
    const outNone = selectPromptInjections({ rules }, { apiKeyId: "key_c", resolvedModel: "other/model" });
    assert.deepEqual(outNone, []);
  });

  it("rules: matches model when using alias prefix or bare model name", () => {
    const rules = [
      {
        id: "r_alias",
        name: "Alias Match",
        enabled: true,
        mode: "single",
        content: "MATCHED_ALIAS",
        models: ["cc/claude-sonnet-4-5"],
        apiKeys: ["*"],
      },
    ];

    // Request routed through combo with resolvedModel "claude/claude-sonnet-4-5" and bare "claude-sonnet-4-5"
    const out = selectPromptInjections({ rules }, {
      requestedModel: "my-combo",
      resolvedModel: "claude/claude-sonnet-4-5",
      bareModel: "claude-sonnet-4-5",
    });
    assert.deepEqual(out.map((p) => p.text), ["MATCHED_ALIAS"]);
  });

  it("rules: stacks strictly in array order", () => {
    const ruleA = { id: "ra", name: "A", enabled: true, mode: "single", content: "AAA", models: ["*"], apiKeys: ["*"] };
    const ruleB = { id: "rb", name: "B", enabled: true, mode: "single", content: "BBB", models: ["*"], apiKeys: ["*"] };
    const ruleC = { id: "rc", name: "C", enabled: true, mode: "single", content: "CCC", models: ["*"], apiKeys: ["*"] };

    const out1 = selectPromptInjections({ rules: [ruleA, ruleB, ruleC] }, { resolvedModel: "m1" });
    assert.deepEqual(out1.map((p) => p.text), ["AAA", "BBB", "CCC"]);

    const out2 = selectPromptInjections({ rules: [ruleC, ruleA, ruleB] }, { resolvedModel: "m1" });
    assert.deepEqual(out2.map((p) => p.text), ["CCC", "AAA", "BBB"]);
  });

  it("rules: live reference dynamically pulls from templates", () => {
    const templates = [
      { id: "tpl_1", name: "Security Persona", mode: "single", content: "You are security bot v1.", enabled: true },
      { id: "tpl_2", name: "Chat Script", mode: "chat", turns: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], enabled: true },
    ];

    const rules = [
      { id: "r_live", name: "Rule Live", enabled: true, templateId: "tpl_1", models: ["*"], apiKeys: ["*"] },
      { id: "r_chat", name: "Rule Chat", enabled: true, templateId: "tpl_2", models: ["*"], apiKeys: ["*"] },
    ];

    const out1 = selectPromptInjections({ rules, templates }, { resolvedModel: "m1" });
    assert.equal(out1.length, 2);
    assert.equal(out1[0].text, "You are security bot v1.");
    assert.equal(out1[1].mode, "chat");
    assert.equal(out1[1].turns.length, 2);

    // When template content changes dynamically, rule reflects it immediately
    templates[0].content = "You are security bot v2 (UPDATED).";
    const out2 = selectPromptInjections({ rules, templates }, { resolvedModel: "m1" });
    assert.equal(out2[0].text, "You are security bot v2 (UPDATED).");
  });

  it("rules: dangling template reference falls back safely without throwing", () => {
    const rules = [
      { id: "r_dangling", name: "Dangling", enabled: true, templateId: "non_existent_tpl", content: "FALLBACK", models: ["*"], apiKeys: ["*"] },
      { id: "r_broken", name: "Broken", enabled: true, templateId: "missing_no_content", models: ["*"], apiKeys: ["*"] },
    ];
    const out = selectPromptInjections({ rules, templates: [] }, { resolvedModel: "m1" });
    assert.equal(out.length, 1);
    assert.equal(out[0].text, "FALLBACK");
  });

  it("cleanRule normalizes models, keys, positions, and live template references", () => {
    const rule = cleanRule({
      name: "  Security Guard  ",
      templateId: "tpl_123",
      position: "prepend",
      models: ["openai/gpt-4o", "  *  ", "openai/gpt-4o"],
      apiKeys: ["  key_1  ", "key_2"],
    });
    assert.equal(rule.name, "Security Guard");
    assert.equal(rule.templateId, "tpl_123");
    assert.equal(rule.position, "prepend");
    assert.ok(rule.models.includes("*"));
    assert.ok(rule.models.includes("openai/gpt-4o"));
    assert.deepEqual(rule.apiKeys, ["key_1", "key_2"]);
    assert.ok(rule.id.startsWith("rule-"));
  });
});

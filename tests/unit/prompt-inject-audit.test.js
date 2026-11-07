import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { injectSystemPrompt, injectChatTurns } from "open-sse/rtk/systemInject.js";
import { FORMATS } from "open-sse/translator/formats.js";

let tmpDir;
let statsRepo;
let repo;
let apiGet;
let apiPut;
let apiDelete;
let statsApiGet;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-audit-"));
  process.env.DATA_DIR = tmpDir;

  statsRepo = await import("@/lib/db/repos/promptInjectStatsRepo.js");
  repo = await import("@/lib/db/repos/promptInjectRepo.js");
  const apiRoute = await import("@/app/api/prompt-injection/route.js");
  apiGet = apiRoute.GET;
  apiPut = apiRoute.PUT;
  apiDelete = apiRoute.DELETE;

  const statsRoute = await import("@/app/api/prompt-injection/stats/route.js");
  statsApiGet = statsRoute.GET;
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("1. Stats Classification & Tracking (classifyInjectStack)", () => {
  it("handles keyModelNames as an Array, Set, and Object without throwing", () => {
    const stack = [
      { name: "openai/gpt-4o", mode: "single", text: "prompt text", scope: "modelKey" },
    ];
    const apiKeyId = "key_1";

    // 1. Array (passed from chat.js via Object.keys)
    const fires1 = statsRepo.classifyInjectStack(stack, {
      apiKeyId,
      isVariantPick: false,
      keyModelNames: ["openai/gpt-4o"],
    });
    expect(fires1[0].scope).toBe("modelKey");
    expect(fires1[0].key).toBe(`km:${apiKeyId}::openai/gpt-4o`);

    // 2. Set
    const fires2 = statsRepo.classifyInjectStack(stack, {
      apiKeyId,
      isVariantPick: false,
      keyModelNames: new Set(["openai/gpt-4o"]),
    });
    expect(fires2[0].scope).toBe("modelKey");

    // 3. Object
    const fires3 = statsRepo.classifyInjectStack(stack, {
      apiKeyId,
      isVariantPick: false,
      keyModelNames: { "openai/gpt-4o": true },
    });
    expect(fires3[0].scope).toBe("modelKey");
  });

  it("correctly classifies all scope types: global, key, rule, variant, model, modelKey", () => {
    const stack = [
      { name: "global", mode: "single", text: "G", scope: "global" },
      { name: "user", mode: "single", text: "U", scope: "key" },
      { name: "Rule A", mode: "single", text: "R", scope: "rule", ruleId: "rule-123" },
      { name: "dahlunce", mode: "single", text: "V", scope: "variant" },
    ];
    const fires = statsRepo.classifyInjectStack(stack, {
      apiKeyId: "key_xyz",
      isVariantPick: true,
    });

    expect(fires.map((f) => f.scope)).toEqual(["global", "key", "rule", "variant"]);
    expect(fires[0].key).toBe("global");
    expect(fires[1].key).toBe("key:key_xyz");
    expect(fires[2].key).toBe("rule:rule-123");
    expect(fires[3].key).toBe("variant:dahlunce");
  });

  it("mergeDayStats aggregates request count and scopes correctly", () => {
    const initial = { requests: 1, byScope: { global: 1 }, byName: { global: { scope: "global", fires: 1 } } };
    const rec = {
      fires: [
        { scope: "global", key: "global" },
        { scope: "variant", key: "variant:test" },
      ],
    };
    const merged = statsRepo.mergeDayStats(initial, rec);
    expect(merged.requests).toBe(2);
    expect(merged.byScope.global).toBe(2);
    expect(merged.byScope.variant).toBe(1);
    expect(merged.byName["variant:test"].fires).toBe(1);
  });
});

describe("2. Selection & Stacking Logic (selectPromptInjectionsDetailed)", () => {
  it("enforces priority stacking order: global -> key -> rules -> variant -> model -> modelKey", () => {
    const scope = {
      global: { content: "P_GLOBAL", position: "append", enabled: true },
      byKey: { key_1: { content: "P_KEY", position: "append", enabled: true } },
      rules: [
        { id: "r1", name: "Rule 1", content: "P_RULE", position: "append", enabled: true, models: ["*"], apiKeys: ["*"] },
      ],
      byVariant: {},
      byModel: { "openai/gpt-4o": { content: "P_MODEL", position: "append", enabled: true } },
      byKeyModel: { key_1: { "openai/gpt-4o": { content: "P_KM", position: "append", enabled: true } } },
    };

    const detailed = repo.selectPromptInjectionsDetailed(scope, {
      apiKeyId: "key_1",
      requestedModel: "openai/gpt-4o",
      resolvedModel: "openai/gpt-4o",
    });

    expect(detailed.isVariantPick).toBe(false);
    expect(detailed.stack.map((s) => s.text)).toEqual(["P_GLOBAL", "P_KEY", "P_RULE", "P_MODEL", "P_KM"]);
    expect(detailed.stack.map((s) => s.scope)).toEqual(["global", "key", "rule", "model", "modelKey"]);
  });

  it("variant pick injects variant prompt and suppresses raw model / modelKey scopes", () => {
    const scope = {
      global: { content: "P_GLOBAL", position: "append", enabled: true },
      byKey: {},
      rules: [],
      byVariant: {
        my_custom_model: {
          model: "openai/gpt-4o",
          content: "P_VARIANT",
          position: "append",
          enabled: true,
        },
      },
      byModel: { "openai/gpt-4o": { content: "P_RAW_MODEL", position: "append", enabled: true } },
      byKeyModel: { key_1: { "openai/gpt-4o": { content: "P_RAW_KM", position: "append", enabled: true } } },
    };

    const detailed = repo.selectPromptInjectionsDetailed(scope, {
      apiKeyId: "key_1",
      requestedModel: "my_custom_model", // bare name = variant pick
      resolvedModel: "openai/gpt-4o",
    });

    expect(detailed.isVariantPick).toBe(true);
    expect(detailed.stack.map((s) => s.text)).toEqual(["P_GLOBAL", "P_VARIANT"]);
    expect(detailed.stack.some((s) => s.text.includes("P_RAW"))).toBe(false);
  });

  it("supports Multi-Model / Multi-Key Rules with Live Template References", () => {
    const templates = [
      { id: "tpl_sys", name: "System Guard", mode: "single", content: "You are guarded.", enabled: true },
      { id: "tpl_chat", name: "Few Shot", mode: "chat", turns: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Greetings" }], enabled: true },
    ];
    const rules = [
      { id: "r_live", name: "Live Rule", enabled: true, templateId: "tpl_sys", models: ["openai/*", "gpt-4o"], apiKeys: ["*"] },
      { id: "r_chat", name: "Chat Rule", enabled: true, templateId: "tpl_chat", models: ["*"], apiKeys: ["key_a"] },
    ];

    const out = repo.selectPromptInjectionsDetailed({ rules, templates }, {
      apiKeyId: "key_a",
      requestedModel: "gpt-4o",
      resolvedModel: "openai/gpt-4o",
      bareModel: "gpt-4o",
    });

    expect(out.stack.length).toBe(2);
    expect(out.stack[0].text).toBe("You are guarded.");
    expect(out.stack[0].scope).toBe("rule");
    expect(out.stack[1].mode).toBe("chat");
    expect(out.stack[1].turns.length).toBe(2);
  });
});

describe("3. Variant Name Validation & Sampling Overrides", () => {
  it("validates variant names correctly", () => {
    expect(repo.cleanVariantName("my-variant")).toBe("my-variant");
    expect(repo.cleanVariantName("has/slash")).toBe(null);
    expect(repo.cleanVariantName("")).toBe(null);
    expect(repo.cleanVariantName("a".repeat(81))).toBe(null);
    expect(repo.cleanVariantName("a".repeat(80))).toBe("a".repeat(80));

    expect(repo.isReservedVariantName("global")).toBe(true);
    expect(repo.isReservedVariantName("user")).toBe(true);
    expect(repo.isReservedVariantName("custom")).toBe(false);
  });

  it("validates and applies variant sampling overrides", () => {
    const cleaned = repo.cleanSamplingParams({
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: 4096,
      invalid_key: 123,
    });
    expect(cleaned).toEqual({ temperature: 0.7, top_p: 0.95, max_tokens: 4096 });

    const body = { temperature: 1.0, top_p: 1.0, max_tokens: 100, stream: true };
    const modified = repo.applyVariantSampling(body, cleaned);
    expect(modified.temperature).toBe(0.7);
    expect(modified.top_p).toBe(0.95);
    expect(modified.max_tokens).toBe(4096);
    expect(modified.stream).toBe(true);
  });
});

describe("4. Wire Injections across Formats (systemInject.js)", () => {
  it("OpenAI: prepends and appends cleanly, and ensures idempotency", () => {
    const body = { messages: [{ role: "system", content: "BASE" }, { role: "user", content: "hi" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, "PRE", "prepend");
    expect(body.messages[0].content).toBe("PRE\n\nBASE");

    injectSystemPrompt(body, FORMATS.OPENAI, "POST", "append");
    expect(body.messages[0].content).toBe("PRE\n\nBASE\n\nPOST");

    // Idempotent: repeated inject does nothing
    injectSystemPrompt(body, FORMATS.OPENAI, "POST", "append");
    expect(body.messages[0].content).toBe("PRE\n\nBASE\n\nPOST");
  });

  it("Claude: handles system string and array blocks with cache_control", () => {
    const bodyStr = { system: "BASE" };
    injectSystemPrompt(bodyStr, FORMATS.CLAUDE, "PRE", "prepend");
    expect(bodyStr.system).toBe("PRE\n\nBASE");

    const bodyArr = {
      system: [
        { type: "text", text: "BLOCK_1" },
        { type: "text", text: "CACHED_BLOCK", cache_control: { type: "ephemeral" } },
      ],
    };
    injectSystemPrompt(bodyArr, FORMATS.CLAUDE, "INJECTED", "append");
    // Appended block should be placed BEFORE cache_control block to preserve caching
    expect(bodyArr.system[1].text).toBe("INJECTED");
    expect(bodyArr.system[2].text).toBe("CACHED_BLOCK");
  });

  it("Gemini: injects into systemInstruction safely", () => {
    const body = {
      systemInstruction: { parts: [{ text: "BASE_GEMINI" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    };
    injectSystemPrompt(body, FORMATS.GEMINI, "EXTRA", "append");
    expect(body.systemInstruction.parts[1].text).toBe("EXTRA");
  });

  it("Kiro: NEVER injects top-level systemPrompt; injects safely into userInputMessage", () => {
    const body = {
      conversationState: {
        currentMessage: { userInputMessage: { content: "user query" } },
        history: [],
      },
    };
    injectSystemPrompt(body, FORMATS.KIRO, "KIRO_INSTRUCTION", "prepend");
    expect(body.systemPrompt).toBeUndefined();
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe("KIRO_INSTRUCTION\n\nuser query");
  });

  it("Chat Turns: inserts scripted conversation and merges matching adjacent user turns", () => {
    const body = {
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "Real query" },
      ],
    };
    const turns = [
      { role: "user", content: "Priming Q" },
      { role: "assistant", content: "Priming A" },
      { role: "user", content: "Context continuation" },
    ];
    injectChatTurns(body, FORMATS.OPENAI, turns);
    // The last turn (user) merges with the first real turn (user)
    expect(body.messages.length).toBe(4);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[2].role).toBe("assistant");
    expect(body.messages[3].role).toBe("user");
    expect(body.messages[3].content).toBe("Context continuation\n\nReal query");
  });
});

describe("5. DB Repos CRUD & Snapshot Cache Invalidation", () => {
  it("CRUD Global Injection", async () => {
    const saved = await repo.setInjectGlobal({ content: "Global Prompt 1", position: "prepend" });
    expect(saved.content).toBe("Global Prompt 1");
    expect(saved.position).toBe("prepend");

    const readBack = await repo.getInjectGlobal();
    expect(readBack.content).toBe("Global Prompt 1");

    await repo.setInjectGlobal({});
    expect(await repo.getInjectGlobal()).toBe(null);
  });

  it("CRUD Variants", async () => {
    const v = await repo.setInjectVariant("test-variant", {
      model: "openai/gpt-4o",
      mode: "single",
      content: "Variant System Prompt",
      sampling: { temperature: 0.5 },
    });
    expect(v.model).toBe("openai/gpt-4o");
    expect(v.sampling.temperature).toBe(0.5);

    const map = await repo.getInjectVariants();
    expect(map["test-variant"]).toBeDefined();

    const deleted = await repo.deleteInjectVariant("test-variant");
    expect(deleted).toBe(true);
    expect((await repo.getInjectVariants())["test-variant"]).toBeUndefined();
  });

  it("CRUD Rules & Templates", async () => {
    const tpl = await repo.upsertPromptTemplate({
      name: "Tpl 1",
      mode: "single",
      content: "Template Content",
    });
    expect(tpl.name).toBe("Tpl 1");

    const rule = await repo.upsertInjectRule({
      name: "Rule with Tpl",
      templateId: tpl.id,
      models: ["openai/gpt-4o"],
      apiKeys: ["key_1"],
    });
    expect(rule.name).toBe("Rule with Tpl");

    const rules = await repo.getInjectRules();
    expect(rules.some((r) => r.id === rule.id)).toBe(true);

    await repo.deleteInjectRule(rule.id);
    await repo.deletePromptTemplate(tpl.id);
    expect((await repo.getInjectRules()).some((r) => r.id === rule.id)).toBe(false);
    expect((await repo.getPromptTemplates()).some((t) => t.id === tpl.id)).toBe(false);
  });
});

describe("6. API Endpoints (/api/prompt-injection & /api/prompt-injection/stats)", () => {
  it("PUT and GET /api/prompt-injection", async () => {
    // Save a rule via PUT
    const putReq = new Request("http://localhost/api/prompt-injection", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rule: {
          id: "rule-api-test",
          name: "API Rule",
          content: "Rule via API",
          models: ["*"],
          apiKeys: ["*"],
        },
      }),
    });
    const putRes = await apiPut(putReq);
    expect(putRes.status).toBe(200);

    // Preview via GET
    const getReq = new Request("http://localhost/api/prompt-injection?preview=1&model=openai/gpt-4o");
    const getRes = await apiGet(getReq);
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.stack.some((s) => s.text === "Rule via API")).toBe(true);
  });

  it("Stack Preview: resolves backing model for a variant and matches backing-targeted rules", async () => {
    // 1. Create a variant 'my-dahl' pointing to 'dahl/deepseek-ai/DeepSeek-V4-Flash-0731'
    await repo.setInjectVariant("my-dahl", {
      model: "dahl/deepseek-ai/DeepSeek-V4-Flash-0731",
      mode: "single",
      content: "Variant Own Prompt",
    });

    // 2. Create a rule targeting the backing model 'dahl/deepseek-ai/DeepSeek-V4-Flash-0731'
    await repo.upsertInjectRule({
      id: "rule-backing",
      name: "Backing Model Rule",
      content: "Rule for Dahl Backing",
      models: ["dahl/deepseek-ai/DeepSeek-V4-Flash-0731"],
      apiKeys: ["*"],
    });

    // 3. Preview for 'my-dahl'
    const previewReq = new Request("http://localhost/api/prompt-injection?preview=1&model=my-dahl");
    const previewRes = await apiGet(previewReq);
    expect(previewRes.status).toBe(200);
    const body = await previewRes.json();
    // Both the rule (targeting backing dahl/*) and the variant prompt must be in preview stack
    const texts = body.stack.map((s) => s.text);
    expect(texts).toContain("Rule for Dahl Backing");
    expect(texts).toContain("Variant Own Prompt");

    // Clean up
    await repo.deleteInjectVariant("my-dahl");
    await repo.deleteInjectRule("rule-backing");
  });

  it("DELETE /api/prompt-injection supports ruleId and global=1", async () => {
    // Set global first
    await apiPut(new Request("http://localhost/api/prompt-injection", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ global: { content: "Temp Global" } }),
    }));

    // Delete global via ?global=1
    const delGlobalRes = await apiDelete(new Request("http://localhost/api/prompt-injection?global=1"));
    expect(delGlobalRes.status).toBe(200);
    const delGlobalBody = await delGlobalRes.json();
    expect(delGlobalBody.deleted).toBe(true);

    // Delete rule via ?ruleId=
    const delRuleRes = await apiDelete(new Request("http://localhost/api/prompt-injection?ruleId=rule-api-test"));
    expect(delRuleRes.status).toBe(200);
    const delRuleBody = await delRuleRes.json();
    expect(delRuleBody.deleted).toBe(true);
  });

  it("GET /api/prompt-injection/stats returns days and totals", async () => {
    const statsReq = new Request("http://localhost/api/prompt-injection/stats?days=7");
    const statsRes = await statsApiGet(statsReq);
    expect(statsRes.status).toBe(200);
    const stats = await statsRes.json();
    expect(Array.isArray(stats.days)).toBe(true);
    expect(stats.totals).toBeDefined();
    expect(typeof stats.totals.requests).toBe("number");
  });
});

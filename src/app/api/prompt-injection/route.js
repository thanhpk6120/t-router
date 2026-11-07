import { NextResponse } from "next/server";
import {
  getInjectModelPrompts, getInjectUserPrompts, getInjectGlobal, getInjectKeyModelPrompts,
  setInjectModelPrompt, setInjectUserPrompt, setInjectGlobal, setInjectKeyModelPrompt,
  deleteInjectModelPrompt, deleteInjectUserPrompt, deleteInjectKeyModelPrompt,
  getInjectVariants, setInjectVariant, deleteInjectVariant, migrateModelPromptsToVariants,
  getModelAliases, isReservedVariantName,
  getPromptTemplates, upsertPromptTemplate, deletePromptTemplate,
  getInjectRules, setInjectRules, upsertInjectRule, deleteInjectRule,
} from "@/lib/localDb";
import { getComboByName } from "@/lib/db/repos/combosRepo.js";
import { selectPromptInjections } from "@/lib/db/repos/promptInjectRepo.js";
import { getProviderNodes, resolveRoutableBacking } from "@/lib/db/repos/nodesRepo.js";

// Prompt Injection (T Router) — one injection per target coordinate:
// global, per API key, per variant (custom-named model), or per model+key
// — plus multi-target Rules (multi-model, multi-key) and template library.
// A variant is a custom name backed by one provider/model: picking the
// variant serves that model WITH the prompt; picking the raw model serves
// it WITHOUT any prompt, so the original model name is never disturbed.
// A variant name routes directly to its backing model — no combo object
// is created for it, so the Kombinasi page shows only combos the user made.
// GET    /api/prompt-injection             → { global, userPrompts, prompts, keyModelPrompts, variants, templates, rules }
// GET    /api/prompt-injection?preview=1&model=<name>&keyId=<id> → { stack }
// PUT    /api/prompt-injection             → { global: entry|null }
//                                          | { rule: { id?, name, models, apiKeys, position, enabled, templateId?, ... } }
//                                          | { rules: [ ... ] }
//                                          | { template: { id?, name, mode, content|turns, position, enabled } }
//                                          | { keyId, mode, content|turns, position, enabled, templateName? }
//                                          | { variant: { name, model, mode, content|turns, position, enabled, templateName? } }
//                                          | { keyId, model, mode, ... }  (model+key coordinate)
// DELETE /api/prompt-injection?ruleId=<id>          → rule
//        /api/prompt-injection?variant=<name>       → variant
//        /api/prompt-injection?model=<name>         → model coordinate (legacy cleanup)
//        /api/prompt-injection?keyId=<id>           → key coordinate
//        /api/prompt-injection?keyId=<id>&model=<n> → model+key coordinate
//        /api/prompt-injection?templateId=<id>      → template
export async function GET(request) {
  try {
    await migrateModelPromptsToVariants().catch(() => {});
    const [global, userPrompts, prompts, keyModelPrompts, variants, templates, rules] = await Promise.all([
      getInjectGlobal(),
      getInjectUserPrompts(),
      getInjectModelPrompts(),
      getInjectKeyModelPrompts(),
      getInjectVariants(),
      getPromptTemplates(),
      getInjectRules(),
    ]);
    // Stack preview: exactly what one request would receive, in order.
    // Canonicalize alias-prefix forms (e.g. tokenharbor/...) to the
    // node-id form chat uses, so model/model+key scopes report exactly
    // as chat would resolve them. Bare variant names pass through
    // untouched; on any failure the raw input is used (fail-open).
    const params = new URL(request.url).searchParams;
    if (params.get("preview")) {
      const model = params.get("model") || "";
      let targetModel = model;
      if (!model.includes("/") && variants[model]?.model) {
        targetModel = variants[model].model;
      }
      let resolvedModel = targetModel;
      try {
        if (targetModel.includes("/")) {
          const routed = resolveRoutableBacking(targetModel, await getProviderNodes().catch(() => []));
          if (typeof routed === "string" && routed) resolvedModel = routed;
        }
      } catch { /* fail-open: preview with the raw input */ }
      const bareModel = resolvedModel.includes("/")
        ? resolvedModel.slice(resolvedModel.lastIndexOf("/") + 1)
        : (targetModel.includes("/") ? targetModel.slice(targetModel.lastIndexOf("/") + 1) : model);
      const stack = selectPromptInjections(
        { global, byKey: userPrompts, byModel: prompts, byKeyModel: keyModelPrompts, byVariant: variants, rules, templates },
        {
          apiKeyId: params.get("keyId") || null,
          requestedModel: model,
          resolvedModel,
          bareModel,
        }
      );
      return NextResponse.json({ stack });
    }
    return NextResponse.json({ global, userPrompts, prompts, keyModelPrompts, variants, templates, rules });
  } catch (error) {
    console.log("Error fetching prompt injections:", error);
    return NextResponse.json({ error: "Failed to fetch prompt injections" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    if (Object.prototype.hasOwnProperty.call(body, "global")) {
      const saved = await setInjectGlobal(body.global || {});
      return NextResponse.json({ global: saved });
    }
    if (body.rule && typeof body.rule === "object") {
      const saved = await upsertInjectRule(body.rule);
      if (!saved) {
        return NextResponse.json({ error: "Invalid rule: needs a prompt or valid template" }, { status: 400 });
      }
      return NextResponse.json({ rule: saved });
    }
    if (Array.isArray(body.rules)) {
      const saved = await setInjectRules(body.rules);
      return NextResponse.json({ rules: saved });
    }
    if (body.template && typeof body.template === "object") {
      const saved = await upsertPromptTemplate(body.template);
      if (!saved) {
        return NextResponse.json({ error: "Invalid template: needs a name and content" }, { status: 400 });
      }
      return NextResponse.json({ template: saved });
    }

    const hasKey = typeof body.keyId === "string" && !!body.keyId;
    const hasModel = typeof body.model === "string" && !!body.model;
    // Variant: a custom name backed by one provider/model. The name is
    // the identity — it must not collide with an existing combo or alias.
    if (body.variant && typeof body.variant === "object") {
      const v = body.variant;
      const name = typeof v.name === "string" ? v.name.trim() : "";
      if (!name || name.length > 80 || name.includes("/")) {
        return NextResponse.json(
          { error: "Variant needs a custom name without \"/\" and at most 80 characters (e.g. dahlunce)" },
          { status: 400 }
        );
      }
      if (isReservedVariantName(name)) {
        return NextResponse.json(
          { error: `Variant name "${name}" is reserved — pick another name` },
          { status: 400 }
        );
      }
      const backing = typeof v.model === "string" ? v.model.trim() : "";
      if (!backing.includes("/")) {
        return NextResponse.json(
          { error: "Variant needs a backing model in \"provider/model\" form" },
          { status: 400 }
        );
      }
      const existing = (await getInjectVariants())[name];
      if (!existing && (await getComboByName(name).catch(() => null))) {
        return NextResponse.json(
          { error: `Name "${name}" is already used by a combo — pick another name` },
          { status: 400 }
        );
      }
      if (!existing) {
        const aliases = await getModelAliases().catch(() => ({}));
        if (aliases && typeof aliases === "object" && name in aliases) {
          return NextResponse.json(
            { error: `Name "${name}" is already used by a model alias — pick another name` },
            { status: 400 }
          );
        }
      }
      const saved = await setInjectVariant(name, v);
      if (!saved) {
        return NextResponse.json(
          { error: "Invalid variant entry: needs a prompt or turns" },
          { status: 400 }
        );
      }
      return NextResponse.json({ variant: saved });
    }
    if (hasKey && hasModel) {
      const saved = await setInjectKeyModelPrompt(body.keyId, body.model, body);
      return NextResponse.json({ entry: saved });
    }
    if (hasKey) {
      const saved = await setInjectUserPrompt(body.keyId, body);
      return NextResponse.json({ entry: saved });
    }
    if (hasModel) {
      const saved = await setInjectModelPrompt(body.model, body);
      return NextResponse.json({ entry: saved });
    }
    return NextResponse.json(
      { error: "Provide rule, rules, template, variant, global, keyId, model, or both" },
      { status: 400 }
    );
  } catch (error) {
    console.log("Error saving prompt injection:", error);
    return NextResponse.json({ error: "Failed to save prompt injection" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const params = new URL(request.url).searchParams;
    const variant = params.get("variant");
    const model = params.get("model");
    const keyId = params.get("keyId");
    const templateId = params.get("templateId");
    const ruleId = params.get("ruleId");
    const isGlobal = params.get("global") === "1" || params.get("global") === "true";
    if (isGlobal) {
      await setInjectGlobal({});
      return NextResponse.json({ deleted: true });
    }
    if (ruleId) return NextResponse.json({ deleted: await deleteInjectRule(ruleId) });
    if (templateId) return NextResponse.json({ deleted: await deletePromptTemplate(templateId) });
    if (variant) return NextResponse.json({ deleted: await deleteInjectVariant(variant) });
    if (model && keyId) return NextResponse.json({ deleted: await deleteInjectKeyModelPrompt(keyId, model) });
    if (model) return NextResponse.json({ deleted: await deleteInjectModelPrompt(model) });
    if (keyId) return NextResponse.json({ deleted: await deleteInjectUserPrompt(keyId) });
    return NextResponse.json({ error: "Provide global, ruleId, variant, model, keyId, or templateId" }, { status: 400 });
  } catch (error) {
    console.log("Error deleting prompt injection:", error);
    return NextResponse.json({ error: "Failed to delete prompt injection" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, getCustomModels } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// T Router: the catalog is near-static (constants + aliases + disabled +
// custom rows) but ~320KB to build and ship — cache the payload for 30s so
// dashboard loads after the first are instant. Alias/disabled/custom edits
// show up within the TTL.
const MODELS_CACHE_TTL_MS = 30000;
let modelsCache = { at: 0, payload: null };

// Test hook (precedent: __resetKeyRateLimiter): drop the cached catalog so a
// test can re-drive GET with different aliases/disabled/custom rows.
export function __resetModelsCache() {
  modelsCache = { at: 0, payload: null };
}

// GET /api/models - Get models with aliases
export async function GET() {
  try {
    if (modelsCache.payload && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) {
      return NextResponse.json(modelsCache.payload);
    }
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();

    const models = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        const c = getCapabilitiesForModel(m.provider, m.model);
        return {
          ...m,
          fullModel,
          routedModel,
          alias: modelAliases[fullModel] || m.model,
          caps: {
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            contextWindow: c.contextWindow,
            maxOutput: c.maxOutput,
          },
        };
      });

    // Custom models ride along; their stored caps override the name heuristic.
    // A custom row whose provider alias routes to an already-listed model is a
    // pure shadow: the real entry wins (and is listed first), but this row would
    // land later with the same routedModel key and the client's last-write-wins
    // map then serves its thinner caps (a pre-registry "add custom model" row
    // stores {vision, reasoning} only — no contextWindow). Drop the shadow and
    // resolve the survivors' provider id, not the UI alias: the capability
    // tables are keyed by provider id, and an alias like `ocg` misses the
    // provider-scoped entries and falls back to the generic patterns.
    const seenFull = new Set(models.map((m) => m.fullModel));
    const routedEntry = new Map(models.map((m) => [m.routedModel, m]));
    const customModels = (await getCustomModels()).filter((m) => {
      if (!m?.id || (m.kind || m.type || "llm") !== "llm") return false;
      const key = `${m.providerAlias}/${m.id}`;
      const isKnown = routedEntry.has(key) || seenFull.has(key);
      // A custom row carrying explicit caps for an existing built-in model is
      // a caps OVERRIDE, not a shadow — keep it so the merge below applies.
      // Without this, the shadow drop discarded every hand-set capability and
      // a built-in model could never be marked vision for a combo pool.
      const hasCaps = !!(m.caps && Object.keys(m.caps).length);
      return isKnown ? hasCaps : true;
    });
    for (const m of customModels) {
      const fullModel = `${m.providerAlias}/${m.id}`;
      const builtIn = routedEntry.get(fullModel);
      if (builtIn) {
        // Merge onto the built-in entry in place; the client's last-write-wins
        // cap map then serves the overridden value.
        builtIn.caps = { ...(builtIn.caps || {}), ...(m.caps || {}) };
        continue;
      }
      const providerId = ALIAS_TO_ID[m.providerAlias] || m.providerAlias;
      const c = getCapabilitiesForModel(providerId, m.id);
      models.push({
        provider: m.providerAlias,
        model: m.id,
        name: m.name || m.id,
        fullModel,
        routedModel: fullModel,
        alias: modelAliases[fullModel] || m.id,
        caps: {
          vision: c.vision,
          search: c.search,
          reasoning: c.reasoning,
          contextWindow: c.contextWindow,
          maxOutput: c.maxOutput,
          ...(m.caps || {}),
        },
      });
    }

    modelsCache = { at: Date.now(), payload: { models } };
    return NextResponse.json(modelsCache.payload);
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}

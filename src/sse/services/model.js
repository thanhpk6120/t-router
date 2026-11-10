// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes, getInjectVariants } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { getProviderAlias, ALIAS_TO_ID } from "@/shared/constants/providers";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
      const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedOpenAI) {
        return { provider: matchedOpenAI.id, model: parsed.model };
      }

      const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
      const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedAnthropic) {
        return { provider: matchedAnthropic.id, model: parsed.model };
      }

      const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
      const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedEmbedding) {
        return { provider: matchedEmbedding.id, model: parsed.model };
      }
    }

    // Fallback for stale/deleted custom node IDs in modelStr (e.g. openai-compatible-chat-<old-uuid>/<model>)
    if (parsed.provider?.startsWith("openai-compatible-chat-")) {
      const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
      const exists = openaiNodes.some((n) => n.id === parsed.provider);
      if (!exists && openaiNodes.length > 0) {
        return { provider: openaiNodes[0].id, model: parsed.model };
      }
    }
    if (parsed.provider?.startsWith("anthropic-compatible-chat-")) {
      const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
      const exists = anthropicNodes.some((n) => n.id === parsed.provider);
      if (!exists && anthropicNodes.length > 0) {
        return { provider: anthropicNodes[0].id, model: parsed.model };
      }
    }

    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Check if a model (direct model, alias, variant, or combo) is disabled.
 * @param {string} modelStr
 * @param {object} [options]
 * @param {object} [options.disabledByAlias] - Pre-fetched disabled models map to avoid repeated DB calls
 * @param {Set<string>} [options.visiting] - Cycle guard for combos/aliases
 * @returns {Promise<boolean>}
 */
export async function isModelDisabled(modelStr, options = {}) {
  if (!modelStr || typeof modelStr !== "string") return false;
  const visiting = options.visiting || new Set();
  if (visiting.has(modelStr)) return false;
  visiting.add(modelStr);

  const disabledByAlias = options.disabledByAlias || (await getDisabledModels().catch(() => ({})));

  // 1. Check if modelStr is a combo
  let combo = null;
  if (options.combosByName) {
    combo = options.combosByName.get ? options.combosByName.get(modelStr) : options.combosByName[modelStr];
  } else if (!modelStr.includes("/")) {
    combo = await getComboByName(modelStr).catch(() => null);
  }
  if (combo && Array.isArray(combo.models) && combo.models.length > 0) {
    // A combo is considered disabled if ALL its members are disabled
    for (const member of combo.models) {
      const memberDisabled = await isModelDisabled(member, { ...options, visiting: new Set(visiting) });
      if (!memberDisabled) return false;
    }
    return true;
  }

  // 2. Check if modelStr is an inject variant
  const variants = options.variants || (await getInjectVariants().catch(() => ({})));
  if (variants && typeof variants === "object" && variants[modelStr]) {
    const targetModel = variants[modelStr]?.model;
    if (targetModel && typeof targetModel === "string") {
      return isModelDisabled(targetModel, { ...options, visiting });
    }
  }

  // 3. Check if modelStr is a model alias
  const aliases = options.aliases || (await getModelAliases().catch(() => ({})));
  if (aliases && typeof aliases === "object" && aliases[modelStr]) {
    const target = aliases[modelStr];
    if (target && typeof target === "string" && target !== modelStr) {
      return isModelDisabled(target, { ...options, visiting });
    }
  }

  // 4. Parse model info (provider, alias, modelId)
  const parsed = parseModel(modelStr);
  const candidateKeys = new Set();
  if (parsed.providerAlias) {
    candidateKeys.add(parsed.providerAlias);
    const resolvedId = ALIAS_TO_ID?.[parsed.providerAlias];
    if (resolvedId) candidateKeys.add(resolvedId);
  }
  if (parsed.provider) {
    candidateKeys.add(parsed.provider);
    try {
      const alias = getProviderAlias(parsed.provider);
      if (alias) candidateKeys.add(alias);
    } catch {}
  }

  // If this might be a custom provider node prefix
  if (!parsed.isAlias && !RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
    try {
      const nodes = await getProviderNodes().catch(() => []);
      const matchedNode = (nodes || []).find((node) => node.prefix === parsed.providerAlias || node.id === parsed.providerAlias);
      if (matchedNode) {
        if (matchedNode.id) candidateKeys.add(matchedNode.id);
        if (matchedNode.prefix) candidateKeys.add(matchedNode.prefix);
      }
    } catch {}
  }

  const modelId = parsed.model;
  for (const key of candidateKeys) {
    const list = disabledByAlias[key];
    if (Array.isArray(list) && list.includes(modelId)) {
      return true;
    }
  }

  return false;
}

/**
 * Filter an array of combo models, removing any that are disabled.
 * @param {string[]} models
 * @param {object} [options]
 * @returns {Promise<string[]>}
 */
export async function filterActiveComboModels(models, options = {}) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const disabledByAlias = options.disabledByAlias || (await getDisabledModels().catch(() => ({})));
  const results = await Promise.all(
    models.map(async (m) => {
      const disabled = await isModelDisabled(m, { disabledByAlias });
      return disabled ? null : m;
    })
  );
  return results.filter(Boolean);
}

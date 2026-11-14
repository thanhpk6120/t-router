"use client";

import { applyQoderModelNames } from "@/shared/utils/providerCustomModels";

import { useState, useMemo, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";
import CapacityBadges from "./CapacityBadges";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS, FREE_PROVIDERS, FREE_TIER_PROVIDERS, AI_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, getProviderAlias } from "@/shared/constants/providers";
import { parseSearchQuery, matchesSearch } from "@/shared/utils/modelSearchFilter";
import { getDeactivatedProviderIds } from "@/shared/utils/connectionStatus";
import {
  NO_AUTH_PROVIDER_IDS,
  filterDisabledModels,
  resolveAllowlistByProvider,
  bareModelId,
  servedIdsFor,
  catalogFor,
} from "@/shared/utils/selectableModels";
import { normalizeModelRows } from "@/shared/utils/modelRows";

// Provider order: OAuth first, then Free Tier, then API Key (matches dashboard/providers)
const PROVIDER_ORDER = [
  ...Object.keys(OAUTH_PROVIDERS),
  ...Object.keys(FREE_PROVIDERS),
  ...Object.keys(FREE_TIER_PROVIDERS),
  ...Object.keys(APIKEY_PROVIDERS),
];

// Upstream catalogs are not uniform: OpenAI-shaped rows are
// `{ id, object, owned_by }` and carry no display name, so a raw row became a
// chip with an undefined `name` and `a.name.localeCompare(...)` threw
// "Cannot read properties of undefined (reading 'localeCompare')", killing the
// whole picker. normalizeModelRows gives every row `{ id, name }` on the way in.
const CATALOG_TTL_MS = 60_000;
const catalogCache = new Map(); // `${fetchId}` -> { at, entry }

// Resolve one provider's detected catalog. The route answers with the catalog
// the provider page renders, so both sides read one list.
//
// `ok` separates the two very different empty results:
//   ok === true, models === []  → the provider was asked and serves nothing
//   ok === false                → the catalog could not be read at all
// Only the first is authoritative. Treating a read failure as "serves nothing"
// would blank the picker on a transient error, and treating "asked and empty"
// as "unknown" is what let the stale registry leak models the provider does not
// serve — the bug this hook exists to prevent.
async function fetchProviderCatalog(fetchId) {
  const cached = catalogCache.get(fetchId);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.entry;
  try {
    const response = await fetch(`/api/providers/${encodeURIComponent(fetchId)}/models`, { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, models: [] };
    const entry = { ok: true, models: normalizeModelRows(data.models) };
    catalogCache.set(fetchId, { at: Date.now(), entry });
    return entry;
  } catch {
    return { ok: false, models: [] };
  }
}

// Fetch the detected catalog for the FIRST active connection of every provider
// — the exact connection the provider page reads (it takes
// `connections.find(c => c.isActive !== false)` and no other), so the picker and
// that page cannot disagree about which models exist.
//
// No-auth providers own no connection row, so they resolve by provider id: the
// /models route serves their real catalog for those ids. Without this the
// picker had no live list for them and fell back to the static registry, which
// is not the account's active set.
function useLiveCatalogs(isOpen, activeProviders, noAuthProviderIds) {
  const [state, setState] = useState({ catalogs: {}, resolved: new Set() });
  // Provider -> id to ask the /models route about. Array order matters: the
  // provider page shows the first active connection's catalog, and sorting the
  // signature alphabetically (as an earlier version did) could pick a different
  // account and therefore a different list.
  const targets = useMemo(() => {
    const map = new Map();
    for (const p of activeProviders || []) {
      if (p?.provider && p?.id && !map.has(p.provider)) map.set(p.provider, p.id);
    }
    for (const id of noAuthProviderIds || []) {
      if (id && !map.has(id)) map.set(id, id);
    }
    return [...map.entries()];
  }, [activeProviders, noAuthProviderIds]);

  // Parents rebuild the providers array every render, so the effect must not
  // depend on the array itself: it did, and each parent render re-ran the
  // fetch + setState, which re-rendered the parent again — a fetch loop against
  // real upstreams. The signature is the identity that actually matters, and it
  // keeps the provider order (the first active connection wins), so it is also
  // the thing the effect parses.
  const signature = useMemo(
    () => targets.map(([providerId, fetchId]) => `${providerId}=${fetchId}`).join("|"),
    [targets],
  );

  useEffect(() => {
    // A closed picker keeps its last catalogs: reopening refreshes them from
    // the 60s cache. Clearing state synchronously here tripped the
    // react-hooks/set-state-in-effect rule without adding correctness.
    if (!isOpen) return undefined;
    if (!signature) return undefined;
    const pairs = signature.split("|").map((part) => {
      const eq = part.indexOf("=");
      return [part.slice(0, eq), part.slice(eq + 1)];
    });
    let cancelled = false;
    Promise.all(
      pairs.map(async ([providerId, fetchId]) => [providerId, await fetchProviderCatalog(fetchId)])
    )
      .then((entries) => {
        if (cancelled) return;
        const catalogs = {};
        const resolved = new Set();
        for (const [providerId, entry] of entries) {
          if (!entry?.ok) continue;
          resolved.add(providerId);
          if (entry.models.length) catalogs[providerId] = entry.models;
        }
        setState({ catalogs, resolved });
      })
      .catch(() => { if (!cancelled) setState({ catalogs: {}, resolved: new Set() }); });

    return () => { cancelled = true; };
  }, [isOpen, signature]);

  return state;
}

export default function ModelSelectModal({
  isOpen,
  onClose,
  onSelect,
  onDeselect,
  onSelectBatch,
  onDeselectBatch,
  selectedModel,
  activeProviders = [],
  title = "Select Model",
  size = "lg",
  modelAliases = {},
  kindFilter = null,
  capFilter = null,
  addedModelValues = [],
  closeOnSelect = true,
  allowProviderWildcard = false,
}) {
  // Live-fetched connections on modal open, fallback to activeProviders prop
  const [fetchedConnections, setFetchedConnections] = useState(null);

  const fetchConnections = async () => {
    try {
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error(`Failed to fetch providers: ${res.status}`);
      const data = await res.json();
      setFetchedConnections(data.connections || []);
    } catch (error) {
      console.error("Error fetching providers in ModelSelectModal:", error);
      setFetchedConnections([]);
    }
  };

  useEffect(() => {
    if (isOpen) fetchConnections();
  }, [isOpen]);

  const effectiveConnections = useMemo(() => {
    return fetchedConnections !== null ? fetchedConnections : (activeProviders || []);
  }, [fetchedConnections, activeProviders]);

  // Filter effectiveConnections by active state and serviceKinds when kindFilter set (e.g. "webSearch", "webFetch")
  const filteredActiveProviders = useMemo(() => {
    const activeOnly = effectiveConnections.filter((p) => p && p.isActive !== false);
    if (!kindFilter) return activeOnly;
    return activeOnly.filter((p) => {
      const info = AI_PROVIDERS[p.provider];
      const kinds = info?.serviceKinds || ["llm"];
      return kinds.includes(kindFilter);
    });
  }, [effectiveConnections, kindFilter]);

  // Set of provider IDs that have connections configured, but ALL of them are deactivated (isActive === false)
  const deactivatedProviderIds = useMemo(() => {
    return getDeactivatedProviderIds(effectiveConnections);
  }, [effectiveConnections]);

  const { getCaps } = useModelCaps();
  const [searchQuery, setSearchQuery] = useState("");
  const [combos, setCombos] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [disabledModels, setDisabledModels] = useState({});
  // Providers that own no connection row still have a real catalog: the
  // /models route serves it for those ids, so the picker must ask for them too.
  // Kind-filtered the same way the group memo does it, or a media picker would
  // fetch LLM catalogs it never renders.
  const noAuthProviderIds = useMemo(() => {
    const ids = kindFilter
      ? NO_AUTH_PROVIDER_IDS.filter((id) => (AI_PROVIDERS[id]?.serviceKinds || ["llm"]).includes(kindFilter))
      : NO_AUTH_PROVIDER_IDS;
    return ids.filter((id) => !deactivatedProviderIds.has(id));
  }, [kindFilter, deactivatedProviderIds]);

  // Every provider exposes its usable catalog per account, so the static
  // catalog is only a fallback — it goes stale and entitlements differ.
  // `resolved` says which providers were actually asked and answered, which is
  // what makes "asked and empty" distinguishable from "never read".
  const { catalogs: liveCatalogs, resolved: resolvedCatalogProviders } = useLiveCatalogs(
    isOpen,
    filteredActiveProviders,
    noAuthProviderIds,
  );

  const fetchCombos = async () => {
    try {
      const res = await fetch("/api/combos");
      if (!res.ok) throw new Error(`Failed to fetch combos: ${res.status}`);
      const data = await res.json();
      setCombos(data.combos || []);
    } catch (error) {
      console.error("Error fetching combos:", error);
      setCombos([]);
    }
  };

  useEffect(() => {
    if (isOpen) fetchCombos();
  }, [isOpen]);

  const fetchProviderNodes = async () => {
    try {
      const res = await fetch("/api/provider-nodes");
      if (!res.ok) throw new Error(`Failed to fetch provider nodes: ${res.status}`);
      const data = await res.json();
      setProviderNodes(data.nodes || []);
    } catch (error) {
      console.error("Error fetching provider nodes:", error);
      setProviderNodes([]);
    }
  };

  useEffect(() => {
    if (isOpen) fetchProviderNodes();
  }, [isOpen]);

  const fetchCustomModels = async () => {
    try {
      const res = await fetch("/api/models/custom");
      if (!res.ok) throw new Error(`Failed to fetch custom models: ${res.status}`);
      const data = await res.json();
      setCustomModels(data.models || []);
    } catch (error) {
      console.error("Error fetching custom models:", error);
      setCustomModels([]);
    }
  };

  useEffect(() => {
    if (isOpen) fetchCustomModels();
  }, [isOpen]);

  const fetchDisabledModels = async () => {
    try {
      const res = await fetch("/api/models/disabled");
      if (!res.ok) throw new Error(`Failed to fetch disabled models: ${res.status}`);
      const data = await res.json();
      setDisabledModels(data.disabled || {});
    } catch (error) {
      console.error("Error fetching disabled models:", error);
      setDisabledModels({});
    }
  };

  useEffect(() => {
    if (isOpen) fetchDisabledModels();
  }, [isOpen]);

  const allProviders = useMemo(() => ({ ...OAUTH_PROVIDERS, ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS, ...APIKEY_PROVIDERS }), []);

  // Group models by provider with priority order
  const groupedModels = useMemo(() => {
    const groups = {};

    // Kinds where the provider IS the model (no per-model selection needed)
    const PROVIDER_AS_MODEL_KINDS = new Set(["webSearch", "webFetch"]);
    // Kinds that map directly to model.type field
    const TYPED_KINDS = new Set(["image", "tts", "stt", "embedding", "imageToText", "systemone"]);
    // For these kinds, providers without hardcoded models can still be picked (provider-as-model fallback)
    const ALLOW_PROVIDER_FALLBACK_KINDS = new Set(["tts", "image", "webFetch"]);

    // Filter a models[] array by kindFilter (keep only matching kind)
    const filterByKind = (models) => {
      // No kindFilter means the LLM selector. Keep custom models visible because
      // user-added models may have typed capabilities (for example imageToText)
      // while still being valid chat/combo targets.
      if (!kindFilter) return models.filter((m) => m.isPlaceholder || m.isCustom || !getModelKind(m) || getModelKind(m) === "llm");
      if (!TYPED_KINDS.has(kindFilter)) return models;
      return models.filter((m) => m.isPlaceholder || getModelKind(m) === kindFilter);
    };

    // Get all active provider IDs from connections (filtered by kindFilter if set)
    const activeConnectionIds = filteredActiveProviders.map(p => p.provider);

    // No-auth providers: filter by kindFilter as well
    const noAuthIds = (kindFilter
      ? NO_AUTH_PROVIDER_IDS.filter((id) => (AI_PROVIDERS[id]?.serviceKinds || ["llm"]).includes(kindFilter))
      : NO_AUTH_PROVIDER_IDS).filter((id) => !deactivatedProviderIds.has(id));

    // Compatible nodes (OpenAI/Anthropic Compatible) that already have user-added
    // custom models should be selectable even without an API-key connection. Local /
    // self-hosted endpoints (Ollama, internal relays, etc.) don't always need a stored
    // key, so gating on connections hides models the user already added. These nodes
    // are LLM-only, so only surface them when no kind filter is active.
    // See #4177, #2113, #2119, #1988.
    const existingNodeIds = new Set((providerNodes || []).map((n) => n?.id).filter(Boolean));
    const compatibleNodeIds = kindFilter
      ? []
      : customModels
          .map((m) => m.providerAlias)
          .filter((alias) =>
            (isOpenAICompatibleProvider(alias) || isAnthropicCompatibleProvider(alias)) &&
            existingNodeIds.has(alias) &&
            !deactivatedProviderIds.has(alias)
          );

    // Only show connected providers (including both standard and custom)
    const providerIdsToShow = new Set([
      ...activeConnectionIds,  // Only connected providers
      ...noAuthIds,            // No-auth providers (kind-filtered)
      ...compatibleNodeIds,    // Compatible nodes with user-added models
    ].filter((id) => !deactivatedProviderIds.has(id)));

    // What each provider actually serves = the allowlist stored on the
    // connection the provider page edits. Shared helper, so the picker and every
    // other caller read the same row and resolve the same id forms.
    const allowByProvider = resolveAllowlistByProvider(filteredActiveProviders);

    // The provider's own detected catalog, when the route answered. `null` means
    // "not read" (route unreachable, or the request is still in flight) and is
    // the only case where the static registry may stand in. An empty array is a
    // real answer — the provider serves nothing — and must not fall back, or the
    // registry's ghosts come back.
    const servedByProvider = new Map();
    for (const providerId of providerIdsToShow) {
      const served = servedIdsFor(liveCatalogs, resolvedCatalogProviders, providerId);
      if (served) servedByProvider.set(providerId, served);
    }
    const catalogForProvider = (providerId) => catalogFor(liveCatalogs, resolvedCatalogProviders, providerId);

    // Sort by PROVIDER_ORDER
    const sortedProviderIds = [...providerIdsToShow].sort((a, b) => {
      const indexA = PROVIDER_ORDER.indexOf(a);
      const indexB = PROVIDER_ORDER.indexOf(b);
      return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
    });

    sortedProviderIds.forEach((providerId) => {
      const alias = getProviderAlias(providerId);
      const providerInfo = allProviders[providerId] || { name: providerId, color: "#666" };
      const isCustomProvider = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      // For provider-as-model kinds (webSearch/webFetch): emit a single entry where value === providerId
      if (kindFilter && PROVIDER_AS_MODEL_KINDS.has(kindFilter)) {
        groups[providerId] = {
          name: providerInfo.name,
          alias,
          color: providerInfo.color,
          models: [{ id: providerId, name: providerInfo.name, value: providerId }],
        };
        return;
      }

      if (providerInfo.passthroughModels) {
        const aliasModels = Object.entries(modelAliases)
          .filter(([, fullModel]) => fullModel.startsWith(`${alias}/`))
          .map(([aliasName, fullModel]) => ({
            id: fullModel.replace(`${alias}/`, ""),
            name: aliasName,
            value: fullModel,
          }));
        const customRegisteredModels = customModels
          .filter((m) => m.providerAlias === alias)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            value: `${alias}/${m.id}`,
            kind: getModelKind(m),
            isCustom: true,
          }));

        // For typed kinds, only include hardcoded typed models (aliases are typically LLM-only and lack type info)
        let combined = aliasModels;
        if (kindFilter && TYPED_KINDS.has(kindFilter)) {
          const registeredTyped = customRegisteredModels.filter((m) => getModelKind(m) === kindFilter);
          combined = [
            ...registeredTyped,
            ...getModelsByProviderId(providerId)
            .filter((m) => getModelKind(m) === kindFilter)
            .map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) }))
            .filter((m) => !registeredTyped.some((registered) => registered.value === m.value)),
          ];
          // Fallback: provider-as-model when no hardcoded models match (tts/image/webFetch only)
          if (combined.length === 0 && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
            const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter);
            if (supports) combined = [{ id: providerId, name: providerInfo.name, value: alias }];
          }
        } else {
          // LLM/null kind: merge hardcoded models (e.g. mimo-free → mimo-auto) with user-added models
          const registeredLlms = customRegisteredModels.filter((m) => !getModelKind(m) || getModelKind(m) === "llm");
          const seen = new Set([...aliasModels, ...registeredLlms].map((m) => m.value));
          // A passthrough provider (openrouter, opencode, …) publishes its catalog
          // per account. `catalogForProvider` returns that list when the route
          // answered, and null only when it could not be read — then, and only
          // then, the static registry stands in.
          const servedCatalog = catalogForProvider(providerId);
          const hardcoded = (servedCatalog !== null ? servedCatalog : getModelsByProviderId(providerId))
            .filter((m) => !getModelKind(m) || getModelKind(m) === "llm")
            .map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) }))
            .filter((m) => !seen.has(m.value));
          combined = [...registeredLlms, ...aliasModels.filter((m) => !registeredLlms.some((registered) => registered.value === m.value)), ...hardcoded];
        }

        if (combined.length > 0) {
          // Check for custom name from providerNodes (for compatible providers)
          const matchedNode = providerNodes.find(node => node.id === providerId);
          const displayName = matchedNode?.name || providerInfo.name;

          groups[providerId] = {
            name: displayName,
            alias: alias,
            color: providerInfo.color,
            models: combined,
          };
        }
      } else if (isCustomProvider) {
        // Custom (openai/anthropic-compatible) providers are LLM-only — skip for typed media kinds
        if (kindFilter && TYPED_KINDS.has(kindFilter)) return;
        // Find connection object to get prefix synchronously without waiting for providerNodes fetch
        const connection = filteredActiveProviders.find(p => p.provider === providerId) || effectiveConnections.find(p => p.provider === providerId);
        const matchedNode = providerNodes.find(node => node.id === providerId);
        const displayName = matchedNode?.name || connection?.name || providerInfo.name;
        const nodePrefix = connection?.providerSpecificData?.prefix || matchedNode?.prefix || providerId;

        // Aliases are stored using the raw providerId as key (e.g. "openai-compatible-chat-<uuid>/glm-4.7"),
        // so we must filter by providerId, not by the display prefix.
        const nodeModels = Object.entries(modelAliases)
          .filter(([, fullModel]) => fullModel.startsWith(`${providerId}/`))
          .map(([aliasName, fullModel]) => ({
            id: fullModel.replace(`${providerId}/`, ""),
            name: aliasName,
            value: `${nodePrefix}/${fullModel.replace(`${providerId}/`, "")}`,
          }));

        // Merge custom models registered via /api/models/custom for this provider
        // providerAlias in DB uses the raw providerId, not the display prefix
        const registeredCustom = customModels
          .filter((m) => m.providerAlias === providerId)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            value: `${nodePrefix}/${m.id}`,
            isCustom: true,
          }));
        const allowEntry = allowByProvider.get(providerId);
        // Only ids the provider was actually seen serving become rows. An
        // allowlist entry is a *selection*; it is not proof the model exists.
        // Letting it mint a chip is how a stale enabledModels row (or an id the
        // account lost access to) appeared in the picker while the provider page
        // showed nothing.
        const served = servedByProvider.get(providerId);
        const allowModels = allowEntry && served
          ? [...allowEntry.ids]
            .filter((id) => served.has(id))
            .map((id) => ({ id, name: id, value: `${nodePrefix}/${id}` }))
          : [];
        // The provider page reads the node's live /models catalog; the picker
        // must offer the same rows. This used to be missing, so a compatible
        // node with no alias/custom rows rendered only a `model-id` placeholder
        // even though its provider page listed the whole catalog.
        const liveNodeModels = (liveCatalogs[providerId] || []).map((m) => ({
          id: m.id,
          name: m.name || m.id,
          value: `${nodePrefix}/${m.id}`,
        }));
        const seen = new Set();
        const mergedModels = [...allowModels, ...liveNodeModels, ...nodeModels, ...registeredCustom].filter((m) => {
          if (seen.has(m.value)) return false;
          seen.add(m.value);
          return !allowEntry || allowEntry.ids.has(m.id);
        });

        // Always show compatible providers that are connected, even with no aliases.
        // When no aliases exist, show a placeholder so users know it's available.
        const modelsToShow = mergedModels.length > 0 ? mergedModels : [{
          id: `__placeholder__${providerId}`,
          name: `${nodePrefix}/model-id`,
          value: `${nodePrefix}/model-id`,
          isPlaceholder: true,
        }];

        groups[providerId] = {
          name: displayName,
          alias: nodePrefix,
          color: providerInfo.color,
          models: modelsToShow,
          isCustom: true,
          hasModels: mergedModels.length > 0,
        };
      } else {
        // Same rule as the passthrough branch: the route's answer is the
        // provider's catalog; the registry is a fallback for "not read", never
        // for "read and empty".
        const liveModels = catalogForProvider(providerId);
        const hardcodedModels = liveModels !== null
          ? liveModels
          : getModelsByProviderId(providerId);
        const hardcodedIds = new Set(hardcodedModels.map((m) => m.id));

        // Custom models: if no hardcoded models (e.g. openrouter), show all aliases for this provider
        // Otherwise only show aliases where aliasName === modelId ("Add Model" button pattern)
        const hasHardcoded = hardcodedModels.length > 0;
        const customAliasModels = Object.entries(modelAliases)
          .filter(([aliasName, fullModel]) =>
            fullModel.startsWith(`${alias}/`) &&
            (hasHardcoded ? aliasName === fullModel.replace(`${alias}/`, "") : true) &&
            !hardcodedIds.has(fullModel.replace(`${alias}/`, ""))
          )
          .map(([aliasName, fullModel]) => {
            const modelId = fullModel.replace(`${alias}/`, "");
            return { id: modelId, name: aliasName, value: fullModel, isCustom: true };
          });

        // Custom models registered via /api/models/custom (provider "Add Model" button)
        const customAliasIds = new Set(customAliasModels.map((m) => m.id));
        const customRegisteredModels = customModels
          .filter((m) => m.providerAlias === alias && !hardcodedIds.has(m.id) && !customAliasIds.has(m.id))
          .map((m) => ({ id: m.id, name: m.name || m.id, value: `${alias}/${m.id}`, isCustom: true }));

        const merged = [
          ...applyQoderModelNames(hardcodedModels, customModels, alias).map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) })),
          ...customAliasModels,
          ...customRegisteredModels,
        ];
        // Dedupe by value (alias may equal hardcoded id, causing React key collision)
        const seen = new Set();
        let allModels = filterByKind(merged.filter((m) => {
          if (seen.has(m.value)) return false;
          seen.add(m.value);
          return true;
        }));

        // Provider-as-model fallback: providers that support the kind but have no hardcoded models
        // can still be picked (value = providerAlias). Skips embedding (always needs model).
        if (allModels.length === 0 && kindFilter && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
          const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter);
          if (supports) {
            allModels = [{ id: providerId, name: providerInfo.name, value: alias }];
          }
        }

        if (allModels.length > 0) {
          groups[providerId] = {
            name: providerInfo.name,
            alias: alias,
            color: providerInfo.color,
            models: allModels,
          };
        }
      }
    });

    // Filter out disabled models per provider (disabled keyed by storage alias OR providerId)
    filterDisabledModels(groups, disabledModels);

    // Then keep only what the connection's allowlist says the provider serves:
    // an explicit empty list means "publishes nothing", so the provider drops
    // out; a partial one keeps only the chosen models, so the picker always
    // matches "Loaded models" on the provider page.
    Object.entries(groups).forEach(([providerId, group]) => {
      const allow = allowByProvider.get(providerId);
      if (!allow) return;
      const kept = group.models.filter((m) => allow.ids.has(m.id) || allow.ids.has(bareId(m.value)));
      if (kept.length === 0) delete groups[providerId];
      else group.models = kept;
    });

    return groups;
  }, [filteredActiveProviders, modelAliases, allProviders, providerNodes, customModels, disabledModels, kindFilter, effectiveConnections, deactivatedProviderIds, liveCatalogs, resolvedCatalogProviders]);

  // Parse search query into structured query (regex, positive tokens, negative tokens)
  const parsedQuery = useMemo(() => parseSearchQuery(searchQuery), [searchQuery]);

  // Filter combos by search query (and hide combos when kindFilter is set — combos are LLM-only by design)
  const filteredCombos = useMemo(() => {
    if (kindFilter || capFilter) return [];
    if (parsedQuery.isEmpty) return combos;
    return combos.filter(c => matchesSearch(c.name, parsedQuery));
  }, [combos, parsedQuery, kindFilter, capFilter]);

  // Sort models alphabetically, with added models floated to top. Upstream rows are
  // not uniform — a raw `{id, object}` row has no `name`, and `a.name.localeCompare`
  // threw "Cannot read properties of undefined", killing the whole picker. Fall back
  // through value and id so every row still has a comparable label. `normalizeModelRows`
  // above is the primary guard; this is the backstop for registry/alias rows.
  const label = (model) => String(model?.name || model?.value || model?.id || "");
  const sortModels = (models) => {
    const added = models.filter(m => addedModelValues.includes(m.value)).sort((a, b) => label(a).localeCompare(label(b)));
    const rest = models.filter(m => !addedModelValues.includes(m.value)).sort((a, b) => label(a).localeCompare(label(b)));
    return [...added, ...rest];
  };

  // Filter models by search query (supports substring, regex, and negation !token / -token)
  const filteredGroups = useMemo(() => {
    const filtered = {};
    Object.entries(groupedModels).forEach(([providerId, group]) => {
      let models = group.models;
      // Filter by input-modality capability (vision/pdf/audioInput/videoInput).
      if (capFilter) {
        models = models.filter((m) => getCaps(m.value)?.[capFilter] === true);
        if (models.length === 0) return;
      }
      if (!parsedQuery.isEmpty) {
        const providerNameMatches = matchesSearch(group.name, parsedQuery);
        const aliasMatches = allowProviderWildcard && (
          (group.alias && matchesSearch(group.alias, parsedQuery)) ||
          (providerId && matchesSearch(providerId, parsedQuery)) ||
          matchesSearch(`${group.alias}/*`, parsedQuery)
        );

        models = models.filter((m) => {
          if (matchesSearch(m, parsedQuery)) return true;
          // If provider or alias matches, but model doesn't violate negative exclusion terms
          if (providerNameMatches || aliasMatches) {
            if (parsedQuery.negativeTerms.length > 0) {
              return matchesSearch(m, { ...parsedQuery, positiveTerms: [] });
            }
            return true;
          }
          return false;
        });

        if (models.length === 0) return;
      }
      filtered[providerId] = {
        ...group,
        models: sortModels(models),
      };
    });

    return filtered;
  }, [groupedModels, parsedQuery, addedModelValues, allowProviderWildcard]);

  // Visible models available for batch actions (excluding placeholders)
  const visibleModels = useMemo(() => {
    const list = [];
    Object.values(filteredGroups).forEach((group) => {
      group.models.forEach((m) => {
        if (!m.isPlaceholder) {
          list.push(m);
        }
      });
    });
    return list;
  }, [filteredGroups]);

  const visibleUnadded = useMemo(() => {
    return visibleModels.filter((m) => !addedModelValues.includes(m.value));
  }, [visibleModels, addedModelValues]);

  const visibleAdded = useMemo(() => {
    return visibleModels.filter((m) => addedModelValues.includes(m.value));
  }, [visibleModels, addedModelValues]);

  const handleSelectAllVisible = () => {
    if (visibleUnadded.length === 0) return;
    if (onSelectBatch) {
      onSelectBatch(visibleUnadded);
    } else {
      visibleUnadded.forEach((model) => onSelect(model));
    }
  };

  const handleDeselectAllVisible = () => {
    if (visibleAdded.length === 0) return;
    if (onDeselectBatch) {
      onDeselectBatch(visibleAdded);
    } else if (onDeselect) {
      visibleAdded.forEach((model) => onDeselect(model));
    }
  };

  const handleSelect = (model) => {
    const value = model?.value || model?.name || model;
    const isAdded = addedModelValues.includes(value);

    if (isAdded && onDeselect) {
      onDeselect(model);
    } else {
      onSelect(model);
    }

    if (closeOnSelect) {
      onClose();
      setSearchQuery("");
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        onClose();
        setSearchQuery("");
      }}
      title={title}
      size={size}
      className="p-4!"
      footer={null}
    >
      {/* Info bar */}
      <div className="flex items-center gap-2 mb-3 px-2.5 py-2 bg-primary/8 border border-primary/20 rounded-lg text-xs text-text-muted">
        <span className="material-symbols-outlined text-primary shrink-0" style={{ fontSize: "14px" }}>info</span>
        <span>
          {allowProviderWildcard
            ? "Click to add/remove a model, or click a provider name for wildcard (e.g. provider/*). Search supports exclusions (e.g. claude -haiku) and RegEx (/pattern/)."
            : "Click to add, click again to remove. Search supports exclusions (e.g. claude -haiku) and RegEx (/pattern/)."}
        </span>
      </div>

      {/* Search & batch actions */}
      <div className="mb-3 space-y-2">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
            search
          </span>
          <input
            type="text"
            placeholder={
              allowProviderWildcard
                ? "Search models (e.g. claude -haiku, oc/*, /regex/)..."
                : "Search models (e.g. claude -haiku, !embed, /regex/)..."
            }
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-20 py-1.5 bg-surface border border-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {parsedQuery.isRegex && (
              <span className="text-[10px] px-1 py-0.2 rounded bg-primary/10 text-primary font-mono font-medium">
                regex
              </span>
            )}
            {parsedQuery.negativeTerms.length > 0 && !parsedQuery.isRegex && (
              <span className="text-[10px] px-1 py-0.2 rounded bg-amber-500/10 text-amber-500 font-mono font-medium">
                !exclude
              </span>
            )}
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="text-text-muted hover:text-text-main cursor-pointer p-0.5 rounded"
                title="Clear search"
              >
                <span className="material-symbols-outlined text-[14px] leading-none">close</span>
              </button>
            )}
          </div>
        </div>

        {!closeOnSelect && visibleModels.length > 0 && (
          <div className="flex items-center justify-between px-1 text-[11px] text-text-muted">
            <span className="flex items-center gap-1.5">
              <span>{visibleModels.length} models</span>
              {addedModelValues.length > 0 && (
                <span className="text-primary font-medium">({addedModelValues.length} selected)</span>
              )}
            </span>
            <div className="flex items-center gap-1.5">
              {visibleUnadded.length > 0 && (
                <button
                  type="button"
                  onClick={handleSelectAllVisible}
                  className="px-2 py-0.5 rounded text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer"
                  title="Select all filtered models"
                >
                  Select All ({visibleUnadded.length})
                </button>
              )}
              {visibleAdded.length > 0 && (
                <button
                  type="button"
                  onClick={handleDeselectAllVisible}
                  className="px-2 py-0.5 rounded text-[11px] font-medium bg-border/40 text-text-muted hover:text-text-main hover:bg-border/60 transition-colors cursor-pointer"
                  title="Deselect all filtered models"
                >
                  Deselect All ({visibleAdded.length})
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Models grouped by provider - compact */}
      <div className="max-h-[400px] overflow-y-auto space-y-3">
        {/* Combos section - always first */}
        {filteredCombos.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-surface py-0.5">
              <span className="material-symbols-outlined text-primary text-[14px]">layers</span>
              <span className="text-xs font-medium text-primary">Combos</span>
              <span className="text-[10px] text-text-muted">({filteredCombos.length})</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {filteredCombos.map((combo) => {
                const isSelected = selectedModel === combo.name;
                return (
                  <button
                    key={combo.id}
                    onClick={() => handleSelect({ id: combo.name, name: combo.name, value: combo.name })}
                    className={`
                      px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer flex items-center gap-1
                      ${isSelected
                        ? "bg-primary text-white border-primary"
                        : addedModelValues.includes(combo.name)
                          ? "bg-primary border-primary text-white hover:bg-primary-hover"
                          : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                      }
                    `}
                  >
                    {addedModelValues.includes(combo.name) && (
                      <span className="material-symbols-outlined leading-none" style={{ fontSize: "10px" }}>check</span>
                    )}
                    {combo.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Provider models */}
        {Object.entries(filteredGroups).map(([providerId, group]) => {
          const wildcardValue = `${group.alias || providerId}/*`;
          const isWildcardAdded = allowProviderWildcard && addedModelValues.includes(wildcardValue);

          return (
            <div key={providerId}>
              {/* Provider header */}
              <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-surface py-0.5 z-10">
                <ProviderIcon
                  src={`/providers/${providerId}.png`}
                  alt={group.name}
                  size={14}
                  fallbackText={(group.name || providerId).slice(0, 2).toUpperCase()}
                  fallbackColor={group.color}
                />
                {allowProviderWildcard ? (
                  <button
                    type="button"
                    onClick={() => handleSelect({ value: wildcardValue, name: wildcardValue })}
                    title={isWildcardAdded ? `Click to remove wildcard ${wildcardValue}` : `Click to allow all models from ${group.name} (${wildcardValue})`}
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer border ${
                      isWildcardAdded
                        ? "bg-primary text-white border-primary shadow-2xs hover:bg-primary-hover"
                        : "text-primary border-transparent hover:bg-primary/10 hover:border-primary/20"
                    }`}
                  >
                    {isWildcardAdded && (
                      <span className="material-symbols-outlined leading-none text-[12px]">check</span>
                    )}
                    <span>{group.name}</span>
                    <span className={`text-[10px] font-mono px-1 py-0.2 rounded ${isWildcardAdded ? "bg-white/20 text-white" : "text-text-muted bg-sidebar border border-border/50"}`}>
                      {wildcardValue}
                    </span>
                  </button>
                ) : (
                  <span className="text-xs font-medium text-primary">
                    {group.name}
                  </span>
                )}
                <span className="text-[10px] text-text-muted">
                  ({group.models.length})
                </span>
              </div>

            <div className="flex flex-wrap gap-1.5">
              {group.models.map((model) => {
                const isSelected = selectedModel === model.value;
                const isPlaceholder = model.isPlaceholder;
                return (
                  <button
                    key={model.value}
                    onClick={() => handleSelect(model)}
                    title={isPlaceholder ? "Select to pre-fill, then edit model ID in the input" : undefined}
                    className={`
                      px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer
                      ${isPlaceholder
                        ? "border-dashed border-border text-text-muted hover:border-primary/50 hover:text-primary bg-surface italic"
                        : isSelected
                          ? "bg-primary text-white border-primary"
                          : addedModelValues.includes(model.value)
                            ? "bg-primary border-primary text-white hover:bg-primary-hover"
                            : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                      }
                    `}
                  >
                    <span className="flex items-center gap-1">
                      {addedModelValues.includes(model.value) && !isPlaceholder && (
                        <span className="material-symbols-outlined leading-none" style={{ fontSize: "10px" }}>check</span>
                      )}
                      {isPlaceholder ? (
                        <>
                          <span className="material-symbols-outlined text-[11px]">edit</span>
                          {model.name}
                        </>
                      ) : model.isCustom ? (
                        <>
                          {model.name}
                          <span className="text-[9px] opacity-60 font-normal">custom</span>
                          <CapacityBadges caps={getCaps(model.value)} />
                        </>
                      ) : (
                        <>
                          {model.name}
                          <CapacityBadges caps={getCaps(model.value)} />
                        </>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {Object.keys(filteredGroups).length === 0 && filteredCombos.length === 0 && (
        <div className="text-center py-4 text-text-muted">
          <span className="material-symbols-outlined text-2xl mb-1 block">
            search_off
          </span>
          <p className="text-xs">No models found</p>
        </div>
      )}
      </div>
    </Modal>
  );
}

ModelSelectModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSelect: PropTypes.func.isRequired,
  onDeselect: PropTypes.func,
  onSelectBatch: PropTypes.func,
  onDeselectBatch: PropTypes.func,
  selectedModel: PropTypes.string,
  activeProviders: PropTypes.arrayOf(
    PropTypes.shape({
      provider: PropTypes.string.isRequired,
    })
  ),
  title: PropTypes.string,
  size: PropTypes.string,
  modelAliases: PropTypes.object,
  kindFilter: PropTypes.string,
  addedModelValues: PropTypes.arrayOf(PropTypes.string),
  closeOnSelect: PropTypes.bool,
  allowProviderWildcard: PropTypes.bool,
};

import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { getLoadedModels, setLoadedModels } from "@/lib/db/index.js";
import { normalizeModelRows } from "@/shared/utils/modelRows.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { fetchCompatibleProviderModels } from "@/lib/compatibleModels";
import { GEMINI_CONFIG, ANTIGRAVITY_CONFIG, ZED_HOSTED_CONFIG } from "@/lib/oauth/constants/oauth";
import { refreshGoogleToken, refreshCodexToken, updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { ANTIGRAVITY_IDE_BASE_URL, ANTIGRAVITY_IDE_USER_AGENT } from "open-sse/providers/shared.js";
import { resolveOllamaLocalHost } from "open-sse/config/providers.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import { resolveClineModels, resolveClinepassModels } from "open-sse/services/clinepassModels.js";
import { NOUS_MODELS_URL, normalizeNousModels } from "open-sse/services/nous.js";
import codexProvider from "open-sse/providers/registry/codex.js";

const GEMINI_CLI_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";

// Model discovery must identify as the same Codex CLI version as inference.
const CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${codexProvider.transport.cliVersion}`;

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

const parseGeminiCliModels = (data) => {
  if (Array.isArray(data?.models)) {
    return data.models
      .map((item) => {
        const id = item?.id || item?.model || item?.name;
        if (!id) return null;
        return { id, name: item?.displayName || item?.name || id };
      })
      .filter(Boolean);
  }

  if (data?.models && typeof data.models === "object") {
    return Object.entries(data.models)
      .filter(([, info]) => !info?.isInternal)
      .map(([id, info]) => ({
        id,
        name: info?.displayName || info?.name || id,
      }));
  }

  return [];
};

const appendCodexReviewModels = (models) => models.flatMap((model) => {
  const id = model?.id || model?.slug || model?.model || model?.name;
  if (!id) return [];
  const name = model?.display_name || model?.displayName || model?.name || id;
  const normalized = { ...model, id, name };
  const isChatModel = (model?.type || "llm") !== "image" && !id.toLowerCase().includes("embed");
  if (!isChatModel || id.endsWith("-review")) return [normalized];
  return [
    normalized,
    {
      ...normalized,
      id: `${id}-review`,
      name: `${name} Review`,
      upstreamModelId: id,
      quotaFamily: "review",
    },
  ];
});

const parseCodexModels = (data) => appendCodexReviewModels(parseOpenAIStyleModels(data));

const createOpenAIModelsConfig = (url) => ({
  url,
  method: "GET",
  headers: { "Content-Type": "application/json" },
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  parseResponse: parseOpenAIStyleModels
});

const normalizeRoutedNousModels = (data) => normalizeNousModels(data).map((model) => ({
  ...model,
  // Live upstream IDs include a vendor namespace (for example,
  // stepfun/step-5-preview:free). Prefix the owning t routervider so Basic
  // Chat does not parse that namespace as the provider itself.
  id: `nous/${model.id}`,
  upstreamModelId: model.id,
}));

const getStaticProviderModels = (providerId) =>
  getModelsByProviderId(providerId).map((model) => ({
    ...model,
    id: model.id,
    name: model.name || model.id,
  }));

// Every /models payload this route returns goes through normalizeModelRows
// (see src/shared/utils/modelRows.js): upstreams are not uniform, and a raw
// row without a display name crashed the model picker's alphabetical sort.
const normalizeModels = normalizeModelRows;

// Generic custom resolver for OAuth providers that need refresh-on-401 + token persist.
// Receives a `fetchFn(token)` and returns parsed models or throws.
const buildOAuthResolver = ({ refreshFn, fetchFn, parseFn, errorLabel }) => async (connection) => {
  const { accessToken, refreshToken } = connection;
  if (!accessToken) {
    return { error: "No valid token found", status: 401 };
  }
  let warning;
  try {
    let response = await fetchFn(accessToken, connection);
    if (!response.ok && (response.status === 401 || response.status === 403) && refreshToken) {
      const refreshed = await refreshFn(connection);
      if (refreshed?.accessToken) {
        await updateProviderCredentials(connection.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken || refreshToken,
          expiresIn: refreshed.expiresIn,
        });
        connection.accessToken = refreshed.accessToken;
        if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
        response = await fetchFn(refreshed.accessToken, connection);
      }
    }
    if (response.ok) {
      const data = await response.json();
      const models = parseFn(data);
      if (models.length > 0) return { models };
    } else {
      const errorText = await response.text();
      warning = `${errorLabel}: ${response.status} ${errorText}`;
      console.log(`${errorLabel} (falling back to static):`, errorText);
    }
  } catch (error) {
    warning = `${errorLabel}: ${error.message}`;
    console.log(`${errorLabel} (falling back to static):`, error.message);
  }
  return { models: [], warning };
};

// Qoder shares one resolver across intl (qoder) and CN (qoder-cn); the
// credentials carry the connection's provider so qoderModels picks the right
// region's catalog endpoint, and the ids keep the provider prefix.
function buildQoderModelsResolver(providerId) {
  return {
    customResolver: async (connection) => {
      const credentials = {
        provider: providerId,
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
        refreshToken: connection.refreshToken,
        email: connection.email,
        displayName: connection.displayName,
        providerSpecificData: connection.providerSpecificData || {},
      };
      let warning;
      try {
        const result = await resolveQoderModels(credentials, { forceRefresh: true });
        if (result?.models?.length) {
          return {
            models: result.models.map((m) => ({
              // Use the canonical "<providerId>/<key>" id so the dashboard
              // surfaces the same identifier the chat router expects.
              id: `${providerId}/${m.id}`,
              name: m.name,
              contextLength: m.contextLength,
              isVL: m.isVL,
              isReasoning: m.isReasoning,
              maxOutputTokens: m.maxOutputTokens,
              description: m.description,
            })),
          };
        }
        warning = "Qoder returned no models; falling back to static catalog.";
      } catch (error) {
        warning = `Failed to fetch Qoder models: ${error.message}`;
        console.log("Failed to fetch Qoder models dynamically, falling back to static:", error.message);
      }
      return { models: [], warning };
    },
  };
}

// Provider models endpoints configuration
const PROVIDER_MODELS_CONFIG = {
  "muse": {
    url: "https://api.meta.ai/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json", "x-api-version": "1.0.0" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || [],
  },
  claude: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json"
    },
    authHeader: "x-api-key",
    parseResponse: (data) => data.data || []
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authQuery: "key", // Use query param for API key
    parseResponse: (data) => data.models || []
  },
  codex: {
    customResolver: buildOAuthResolver({
      refreshFn: (conn) => refreshCodexToken(conn.refreshToken),
      fetchFn: (token) => fetch(CODEX_MODELS_URL, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${token}`,
          "originator": "codex_cli_rs"
        }
      }),
      parseFn: parseCodexModels,
      errorLabel: "Failed to fetch Codex models"
    })
  },
  antigravity: {
    // Same Cloud Code family as gemini-cli, but the refresh token belongs to
    // the Antigravity hub OAuth client — presenting it under GEMINI_CONFIG
    // fails with invalid_client. The catalog RPC is fetchAvailableModels on
    // the hub base URL (matching the registry's quotaApiUrl), not the dead
    // sandbox /v1internal:models path this entry used to point at.
    customResolver: buildOAuthResolver({
      refreshFn: (conn) => refreshGoogleToken(
        conn.refreshToken,
        ANTIGRAVITY_CONFIG.clientId,
        ANTIGRAVITY_CONFIG.clientSecret,
      ),
      fetchFn: (token, conn) => {
        const projectId = conn.projectId || conn.providerSpecificData?.projectId;
        const body = projectId ? { project: projectId } : {};
        return fetch(`${ANTIGRAVITY_IDE_BASE_URL}/v1internal:fetchAvailableModels`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
            "x-request-source": "local",
          },
          body: JSON.stringify(body),
        });
      },
      parseFn: parseGeminiCliModels,
      errorLabel: "Failed to fetch Antigravity models",
    }),
  },
  github: {
    url: "https://api.githubcopilot.com/models",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "editor-version": "vscode/1.107.1",
      "editor-plugin-version": "copilot-chat/0.26.7",
      "user-agent": "GitHubCopilotChat/0.26.7"
    },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => {
      if (!data?.data) return [];
      // Filter out embeddings, non-chat models, and disabled models
      return data.data
        .filter(m => m.capabilities?.type === "chat")
        .filter(m => m.policy?.state !== "disabled") // Only return explicitly enabled models
        .map(m => ({
          id: m.id,
          name: m.name || m.id,
          version: m.version,
          capabilities: m.capabilities,
          isDefault: m.model_picker_enabled === true
        }));
    }
  },
  openai: createOpenAIModelsConfig("https://api.openai.com/v1/models"),
  openrouter: createOpenAIModelsConfig("https://openrouter.ai/api/v1/models"),
  nous: {
    ...createOpenAIModelsConfig(NOUS_MODELS_URL),
    parseResponse: normalizeRoutedNousModels,
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json"
    },
    authHeader: "x-api-key",
    parseResponse: (data) => data.data || []
  },

  alicode: {
    url: "https://coding.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  "alicode-intl": {
    url: "https://coding-intl.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  "alims-intl": {
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  "volcengine-ark": createOpenAIModelsConfig("https://ark.cn-beijing.volces.com/api/coding/v3/models"),
  byteplus: createOpenAIModelsConfig("https://ark.ap-southeast.bytepluses.com/api/coding/v3/models"),

  // OpenAI-compatible API key providers
  deepseek: createOpenAIModelsConfig("https://api.deepseek.com/models"),
  groq: createOpenAIModelsConfig("https://api.groq.com/openai/v1/models"),
  xai: createOpenAIModelsConfig("https://api.x.ai/v1/models"),
  mistral: createOpenAIModelsConfig("https://api.mistral.ai/v1/models"),
  perplexity: createOpenAIModelsConfig("https://api.perplexity.ai/v1/models"),
  "perplexity-agent": createOpenAIModelsConfig("https://api.perplexity.ai/v1/models"),
  together: createOpenAIModelsConfig("https://api.together.xyz/v1/models"),
  fireworks: createOpenAIModelsConfig("https://api.fireworks.ai/inference/v1/models"),
  cerebras: createOpenAIModelsConfig("https://api.cerebras.ai/v1/models"),
  cohere: createOpenAIModelsConfig("https://api.cohere.ai/v1/models"),
  nebius: createOpenAIModelsConfig("https://api.studio.nebius.ai/v1/models"),
  siliconflow: createOpenAIModelsConfig("https://api.siliconflow.com/v1/models"),
  hyperbolic: createOpenAIModelsConfig("https://api.hyperbolic.xyz/v1/models"),
  ollama: createOpenAIModelsConfig("https://ollama.com/api/tags"),
  // ollama-local: url resolved dynamically below via providerSpecificData.baseUrl
  nanobanana: createOpenAIModelsConfig("https://api.nanobananaapi.ai/v1/models"),
  chutes: createOpenAIModelsConfig("https://llm.chutes.ai/v1/models"),
  nvidia: createOpenAIModelsConfig("https://integrate.api.nvidia.com/v1/models"),
  assemblyai: createOpenAIModelsConfig("https://api.assemblyai.com/v1/models"),
  "vercel-ai-gateway": createOpenAIModelsConfig("https://ai-gateway.vercel.sh/v1/models"),
  // OpenAI-compatible aggregators.
  tokenharbor: createOpenAIModelsConfig("https://tokenharbor.ai/v1/models"),
  dahl: createOpenAIModelsConfig("https://inference.dahl.global/v1/models"),
  atria: createOpenAIModelsConfig("https://api.atria-asi.ai/v1/models"),
  agnes: createOpenAIModelsConfig("https://apihub.agnes-ai.com/v1/models"),
  bai: createOpenAIModelsConfig("https://api.b.ai/v1/models"),
  kimchi: {
    customResolver: async (connection) => {
      const result = await resolveKimchiModels({
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
        providerSpecificData: connection.providerSpecificData || {},
      }, { forceRefresh: true, log: console });
      if (result?.models?.length) {
        return { models: result.models };
      }
      return {
        models: getStaticProviderModels("kimchi"),
        warning: "Kimchi returned no live models; falling back to static catalog.",
      };
    }
  },
  cursor: {
    customResolver: async (connection) => {
      const result = await resolveCursorModels({
        accessToken: connection.accessToken,
        providerSpecificData: connection.providerSpecificData || {},
      }, { forceRefresh: true, log: console });
      if (result?.models?.length) return { models: result.models };
      return {
        models: getStaticProviderModels("cursor"),
        warning: "Cursor returned no live models; falling back to static catalog.",
      };
    },
  },
  // Zed has no static catalog by design (live /models only) — same cursor
  // direct pattern: resolve with the connection's own credentials (never
  // exposed to the browser), return rich metadata, drop disabled entries.
  // Empty/failure yields an explicit warning, never a silent zero list.
  zed: {
    customResolver: async (connection) => {
      try {
        const result = await resolveZedModels({
          accessToken: connection.accessToken,
          providerSpecificData: connection.providerSpecificData || {},
        }, { config: ZED_HOSTED_CONFIG, forceRefresh: true });
        const models = (result?.models || [])
          .filter((m) => m && !m.isDisabled)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            provider: m.provider,
            contextLength: m.contextLength,
            contextLengthInMaxMode: m.contextLengthInMaxMode,
            maxOutputTokens: m.maxOutputTokens,
            supportsTools: m.supportsTools,
            supportsImages: m.supportsImages,
            supportsThinking: m.supportsThinking,
            supportsDisablingThinking: m.supportsDisablingThinking,
            supportsFastMode: m.supportsFastMode,
            supportsServerSideCompaction: m.supportsServerSideCompaction,
            supportedEffortLevels: m.supportedEffortLevels || [],
            supportsStreamingTools: m.supportsStreamingTools,
            supportsParallelToolCalls: m.supportsParallelToolCalls,
          }));
        if (models.length > 0) return { models };
        return { models: [], warning: "Zed returned no live models." };
      } catch (error) {
        console.log("Failed to fetch Zed models dynamically:", error.message);
        return { models: [], warning: `Failed to fetch Zed models: ${error.message}` };
      }
    },
  },

  // Cline/ClinePass share api.cline.bot/api/v1/models. The service layer already
  // handles Bearer-vs-`workos:` auth and swallows failures into null, so these follow
  // the cursor direct pattern (no refreshFn) and only differ in filtering:
  // cline returns the whole catalog verbatim, clinepass keeps cline-pass/* only.
  cline: {
    customResolver: async (connection) => {
      const result = await resolveClineModels({
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
      });
      if (result?.models?.length) return { models: result.models };
      return {
        models: getStaticProviderModels("cline"),
        warning: "Cline returned no live models; falling back to static catalog.",
      };
    },
  },
  clinepass: {
    customResolver: async (connection) => {
      const result = await resolveClinepassModels({
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
      });
      if (result?.models?.length) return { models: result.models };
      return {
        models: getStaticProviderModels("clinepass"),
        warning: "ClinePass returned no live models; falling back to static catalog.",
      };
    },
  },

  // Custom resolvers (non-OpenAI-shaped APIs / token-refresh flows)
  kiro: {
    customResolver: async (connection) => {
      const credentials = {
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken,
        providerSpecificData: connection.providerSpecificData || {}
      };
      let warning;
      try {
        const result = await resolveKiroModels(credentials, {
          log: console,
          onCredentialsRefreshed: async (refreshed) => {
            if (refreshed?.accessToken) {
              await updateProviderCredentials(connection.id, {
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken || connection.refreshToken,
                expiresIn: refreshed.expiresIn,
              });
              connection.accessToken = refreshed.accessToken;
              if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
            }
          }
        });
        if (result?.models?.length) {
          return {
            models: result.models.map((m) => ({
              id: m.id,
              name: m.name,
              upstreamModelId: m.upstreamModelId,
              contextLength: m.contextLength,
              rateMultiplier: m.rateMultiplier,
              capabilities: m.capabilities,
              description: m.description
            }))
          };
        }
        warning = "Kiro returned no models; falling back to static catalog.";
      } catch (error) {
        warning = `Failed to fetch Kiro models: ${error.message}`;
        console.log("Failed to fetch Kiro models dynamically, falling back to static:", error.message);
      }
      return { models: [], warning };
    }
  },
  qoder: buildQoderModelsResolver("qoder"),
  "qoder-cn": buildQoderModelsResolver("qoder-cn"),
  "gemini-cli": {
    customResolver: buildOAuthResolver({
      refreshFn: (conn) => refreshGoogleToken(conn.refreshToken, GEMINI_CONFIG.clientId, GEMINI_CONFIG.clientSecret),
      fetchFn: (token, conn) => {
        const projectId = conn.projectId || conn.providerSpecificData?.projectId;
        const body = projectId ? { project: projectId } : {};
        return fetch(GEMINI_CLI_MODELS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": "google-api-nodejs-client/9.15.1",
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1"
          },
          body: JSON.stringify(body)
        });
      },
      parseFn: parseGeminiCliModels,
      errorLabel: "Failed to fetch Gemini CLI models"
    })
  },
  "grok-cli": {
    customResolver: async (connection) => {
      const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      const result = await resolveGrokCliModels({
        ...connection,
        connectionId: connection.id,
      }, {
        log: console,
        proxyOptions: {
          connectionProxyEnabled: proxy.connectionProxyEnabled === true,
          connectionProxyUrl: proxy.connectionProxyUrl || "",
          connectionNoProxy: proxy.connectionNoProxy || "",
          vercelRelayUrl: proxy.vercelRelayUrl || "",
          strictProxy: proxy.strictProxy === true,
        },
        onCredentialsRefreshed: async (refreshed) => {
          await updateProviderCredentials(connection.id, {
            ...refreshed,
            existingProviderSpecificData: connection.providerSpecificData || {},
          });
        },
      });
      if (result.models.length) return result;
      return {
        models: getStaticProviderModels("grok-cli"),
        warning: result.warning || "Grok CLI returned no live models; using static catalog.",
      };
    },
  },
  "ollama-local": {
    customResolver: async (connection) => {
      const url = `${resolveOllamaLocalHost(connection)}/api/tags`;
      const response = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.log("Error fetching models from ollama-local:", errorText);
        return { error: `Failed to fetch models: ${response.status}`, status: response.status };
      }
      const data = await response.json();
      return { models: parseOpenAIStyleModels(data) };
    }
  }
};

/**
 * GET /api/providers/[id]/models - Get the provider's model catalog.
 *
 * The catalog is persisted in the DB (kv scope "loadedModels", keyed by the
 * connection id — or the provider id for no-auth providers) and served from
 * there. The upstream /models endpoint is only called when this provider has
 * never been fetched, or when the caller asks for a refresh (?refresh=1 — the
 * "Load models from provider" button). Opening a provider page used to call
 * the provider every single time, which made the detail view wait on a live
 * round-trip for a list that had not changed.
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const refresh = searchParams.get("refresh") === "1";
    const connection = await getProviderConnectionById(id);
    const cacheKey = connection?.id || id;

    if (!refresh) {
      const saved = await getLoadedModels(cacheKey);
      if (saved) {
        return NextResponse.json({
          provider: connection?.provider || id,
          connectionId: connection?.id || null,
          models: saved.models,
          source: saved.source || "stored",
          updatedAt: saved.updatedAt,
          cached: true,
        });
      }
    }

    // Persist + answer in one place so every resolver below shares the cache.
    const remember = async (models, extra = {}) => {
      const normalized = normalizeModels(models);
      const updatedAt = new Date().toISOString();
      const source = extra.source || "live";
      if (normalized.length > 0) {
        await setLoadedModels(cacheKey, { models: normalized, updatedAt, source });
      }
      return NextResponse.json({
        provider: connection?.provider || id,
        connectionId: connection?.id || null,
        models: normalized,
        source,
        updatedAt,
        cached: false,
        ...(extra.warning ? { warning: extra.warning } : {}),
      });
    };

    // A failed refresh keeps the catalog the user already has instead of
    // blanking the page because the provider is briefly unreachable.
    const failed = async (message, status) => {
      const saved = await getLoadedModels(cacheKey);
      if (saved) {
        return NextResponse.json({
          provider: connection?.provider || id,
          connectionId: connection?.id || null,
          models: saved.models,
          source: saved.source || "stored",
          updatedAt: saved.updatedAt,
          cached: true,
          stale: true,
          warning: message,
        });
      }
      return NextResponse.json({ error: message }, { status });
    };

    if (!connection) {
      // No-auth providers own no connection rows, so the dashboard cannot pass a
      // connection id. Serve their REAL catalog when the upstream exposes one —
      // OpenCode Zen publishes /v1/models and accepts the anonymous "public"
      // credential (same credential the opencode2api gateway uses) — and fall
      // back to the built-in list only when that is unavailable.
      const ZEN_MODELS = {
        opencode: "https://opencode.ai/zen/v1/models",
        "opencode-go": "https://opencode.ai/zen/go/v1/models",
      };
      const zenUrl = ZEN_MODELS[id];
      if (zenUrl) {
        try {
          const res = await fetch(zenUrl, {
            headers: { Accept: "application/json", Authorization: "Bearer public" },
            signal: AbortSignal.timeout(15000),
          });
          if (res.ok) {
            const data = await res.json().catch(() => null);
            const rows = Array.isArray(data) ? data : (data?.data || data?.models || []);
            const models = rows
              .map((m) => ({ id: m?.id || m?.model, name: m?.name || m?.id || m?.model }))
              .filter((m) => m.id);
            if (models.length > 0) {
              return remember(models, { source: "live" });
            }
          }
        } catch {
          // fall through to the built-in catalog
        }
      }
      const staticModels = getStaticProviderModels(id);
      if (staticModels.length > 0) {
        return remember(staticModels, { source: "static" });
      }
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    if (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider)) {
      const result = await fetchCompatibleProviderModels(connection);
      if (!result.ok) {
        if (result.errorText) console.log(`Error fetching models from ${connection.provider}:`, result.errorText);
        return failed(result.error, result.status);
      }
      return remember(result.models);
    }

    const config = PROVIDER_MODELS_CONFIG[connection.provider];
    if (!config) {
      // Providers with no live resolver used to 400 here, so the provider page
      // showed an empty list and the picker fell back to its static catalog —
      // the two disagreed. Answer with that same static catalog plus a warning
      // so both sides read one list; `source: "static"` lets the UI say so.
      // Reuse the existing helper: it normalizes every entry to { ...model, id,
      // name }, and some registry rows carry no `name` — the picker and the
      // provider page both render `id || name`, so raw rows showed blanks.
      const staticModels = getStaticProviderModels(connection.provider) || [];
      if (staticModels.length === 0) {
        return NextResponse.json(
          { error: `Provider ${connection.provider} does not support models listing` },
          { status: 400 }
        );
      }
      return remember(staticModels, {
        source: "static",
        warning: `No live model endpoint for ${connection.provider}; showing the built-in catalog.`,
      });
    }

    // Config-driven custom resolver path (OAuth refresh, non-OpenAI shape, etc.)
    if (typeof config.customResolver === "function") {
      const result = await config.customResolver(connection);
      if (result.error) {
        return failed(result.error, result.status || 500);
      }
      return remember(result.models, { warning: result.warning });
    }

    // Get auth token
    const token = connection.providerSpecificData?.copilotToken || connection.accessToken || connection.apiKey;
    if (!token) {
      return NextResponse.json({ error: "No valid token found" }, { status: 401 });
    }

    // Build request URL
    let url = config.url;
    if (config.authQuery) {
      url += `?${config.authQuery}=${token}`;
    }

    // Build headers
    const headers = { ...config.headers };
    if (config.authHeader && !config.authQuery) {
      headers[config.authHeader] = (config.authPrefix || "") + token;
    }

    // Make request
    const fetchOptions = {
      method: config.method,
      headers
    };

    if (config.body && config.method === "POST") {
      fetchOptions.body = JSON.stringify(config.body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`Error fetching models from ${connection.provider}:`, errorText);
      return failed(`Failed to fetch models: ${response.status}`, response.status);
    }

    const data = await response.json();
    const models = config.parseResponse(data);

    return remember(models);
  } catch (error) {
    console.log("Error fetching provider models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

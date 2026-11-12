import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { resolveComboMemberAttemptCap } from "../services/memberFailover.js";
import { dispatchCombo, createVariantHelpers, withBreakerSuccess } from "../services/comboDispatch.js";
import { getSettings, getApiKeyByKey, resolvePromptInjections, resolvePromptInjectionMeta, resolveVariantSampling, applyVariantSampling, resolveBriefLevel, recordRtkSavings, getInjectVariants, getProviderConnections, recordPromptInjectFire, classifyInjectStack, getInjectKeyModelPrompts } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { parseAutoTarget, buildAutoCandidates, getLatencyByProviderCached, AUTO_EXPLORATION_SHARE } from "../services/autoRouting.js";
import { getModelInfo, getComboModels, parseModel, isModelDisabled } from "../services/model.js";
import { recordProviderSuccess } from "../services/providerBreaker.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getKeyAccessContext, enforceKeyAccess, filterAdapterModels } from "../services/keyAccess.js";
import { resolveAntiFlakyConfig, inspectChatResponse, inspectChatResponseFull } from "open-sse/rtk/flakyGuard.js";
import { withKeyAdmission, recheckKeyQuotaAfterCompletion } from "../services/keyAdmission.js";
import { buildStreamErrorBytes } from "open-sse/utils/streamHelpers.js";
import { peekStreamForContent, reconstructStream, isNoRetryFinish } from "open-sse/services/emptyFailover.js";
import { EMPTY_PEEK_DEADLINE_MS } from "open-sse/config/runtimeConfig.js";
import { detectFormat } from "open-sse/services/provider.js";
import { requestIdFromRequest, attachRequestId } from "../utils/requestId.js";

export async function handleChat(request, clientRawRequest = null) {
  // D6: one id for this client request. It rides on clientRawRequest
  // into every single-model attempt (combo members included, panel
  // stripping preserves it via object spread) so chatCore can stamp it
  // on usage rows and request-detail records, and it comes back to the
  // client on every response — success, error, or stream — via header.
  const requestId = requestIdFromRequest(request);
  // One deadline for the whole client request. Stamped here and carried
  // on clientRawRequest so every combo member, every nested combo and
  // every account attempt shares it: chatCore used to stamp its own start
  // per member, which handed each of N members a fresh 30-minute budget.
  const requestStartedAt = Date.now();
  // Peek BEFORE anything consumes the body: request.clone() throws on an
  // already-disturbed body, and the silent catch would then disable the
  // keepalive path for every request.
  const shape = await peekClientShape(request);
  const work = withKeyAdmission(request, () => handleChatImpl(request, clientRawRequest, requestId, requestStartedAt), recheckKeyQuotaAfterCompletion);
  // A streaming client must not see dead air while combos/retries/account
  // failover run — the first upstream byte can be many minutes away. Only
  // wrap once the work is still pending after a short grace: a fast
  // success or a fast 4xx must reach the client byte-identical, with its
  // real status. The wrapper then emits an SSE comment every 15s until
  // the real response exists.
  if (shape.stream) {
    const early = await raceGrace(work, 2000);
    if (early) return attachRequestId(early, requestId);
    return attachRequestId(await respondWithKeepalive(work, shape.body), requestId);
  }
  return attachRequestId(await work, requestId);
}

// Resolve with the settled response when it lands inside `ms`, else null.
// A rejection is re-thrown so the caller's error path stays authoritative.
function raceGrace(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// One parse for both decisions: does the client want SSE, and in which
// wire format must a terminal error frame be written (OpenAI / Claude /
// Responses each have their own shape — a hand-rolled frame is malformed
// for two of the three).
async function peekClientShape(request) {
  try {
    const body = await request.clone().json();
    return { stream: body?.stream === true, body };
  } catch { return { stream: false, body: null }; }
}

// Wrap a pending chat response in an SSE body that starts emitting
// keep-alive comments immediately. When the real response lands, its
// bytes are piped through unchanged. A non-SSE outcome (error, forced
// non-stream body) is re-framed in the client's own wire format so a
// Claude or Responses client is never handed an OpenAI-shaped frame.
async function respondWithKeepalive(work, clientBody) {
  const encoder = new TextEncoder();
  const sourceFormat = detectFormat(clientBody || {});
  let timer = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const terminal = (status, message) => buildStreamErrorBytes(status, message, sourceFormat);
  const stream = new ReadableStream({
    start(controller) {
      const beat = () => { try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* closed */ } };
      beat();
      timer = setInterval(beat, 15000);
      work.then(async (res) => {
        stop();
        const ct = res.headers?.get?.("content-type") || "";
        if (res.ok && ct.includes("text/event-stream") && res.body) {
          const reader = res.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          } catch (streamErr) {
            try { controller.enqueue(terminal(502, streamErr?.message || "upstream stream interrupted")); } catch { /* closed */ }
          }
          try { controller.close(); } catch { /* already closed */ }
          return;
        }
        // Non-SSE outcome: try to extract actual error message from body if JSON
        let errMsg = "upstream returned non-stream response";
        try {
          const errorJson = await res.clone().json();
          errMsg = errorJson?.error?.message || errorJson?.message || errMsg;
        } catch {}
        try { controller.enqueue(terminal(res.status || 502, errMsg)); } catch { /* closed */ }
        try { controller.close(); } catch { /* already closed */ }
      }).catch((err) => {
        stop();
        try { controller.enqueue(terminal(502, String(err?.message || err))); } catch { /* closed */ }
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() { stop(); }
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Per-combo member pins live in comboDispatch.js (memberPinFor) so the
// top-level and nested combo branches share one definition.

// Capacity ordering reads every provider's connections; cache the snapshot
// briefly so a capacity-strategy request doesn't scan the whole table each
// time. Staleness only affects ORDER, never correctness — failover still
// tries every member, and locks are re-checked at credential selection.
let capacityConnectionsCache = { at: 0, data: [] };
const CAPACITY_CONNECTIONS_TTL_MS = 10_000;
async function getCapacityConnections() {
  const now = Date.now();
  if (now - capacityConnectionsCache.at < CAPACITY_CONNECTIONS_TTL_MS) return capacityConnectionsCache.data;
  const data = await getProviderConnections().catch(() => []);
  capacityConnectionsCache = { at: now, data };
  return data;
}

// withBreakerSuccess lives in comboDispatch.js (shared with dispatchCombo).

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
async function handleChatImpl(request, clientRawRequest = null, requestId = null, requestStartedAt = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // D6 thread: the request id travels on clientRawRequest so it reaches
  // handleSingleModelChat (and from there chatCore) for every branch —
  // top-level combo, nested combo, solo, fusion panels — without a new
  // positional parameter on every call site.
  if (requestId) clientRawRequest.requestId = requestId;
  // Absolute origin of this client request, shared by every member attempt.
  clientRawRequest.requestStartedAt = requestStartedAt || Date.now();
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  const session = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
  const sessionId = session?.sessionId || null;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Scored auto-routing (P3-25): `auto:<intent>` is not a real model, so the
  // literal target skips the per-key target gate — the RESOLVED candidates
  // are gated instead (filterAdapterModels below), so a restricted key only
  // ever routes to models its allow-list names.
  const autoIntent = parseAutoTarget(modelStr);
  const keyAccess = await getKeyAccessContext(request);
  if (!autoIntent) {
    const keyAccessDenied = await enforceKeyAccess(keyAccess, modelStr);
    if (keyAccessDenied) return keyAccessDenied;

    const allowDisabled = clientRawRequest?.headers?.["x-allow-disabled"] === "1";
    if (!allowDisabled) {
      const comboModels = await getComboModels(modelStr);
      if (!comboModels && await isModelDisabled(modelStr)) {
        log.warn("CHAT", `Requested model "${modelStr}" is disabled`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `Model "${modelStr}" is disabled`);
      }
    }
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Auto-routing resolves to a ranked candidate list and falls back through
  // it in order, like a combo with strategy "fallback" (same member cap).
  if (autoIntent) {
    const connections = await getProviderConnections().catch(() => []);
    const disabled = await getDisabledModels().catch(() => ({}));
    const latencyByProvider = await getLatencyByProviderCached().catch(() => ({}));
    let candidates = buildAutoCandidates({ intent: autoIntent, connections, disabled, latencyByProvider, explorationShare: AUTO_EXPLORATION_SHARE });
    candidates = await filterAdapterModels(keyAccess, candidates, []);
    if (candidates.length === 0) {
      log.warn("CHAT", `Auto-routing "${modelStr}" found no routable model`);
      return errorResponse(
        HTTP_STATUS.NOT_FOUND,
        keyAccess
          ? `No model allowed for this key matches auto:${autoIntent}`
          : `No connected provider offers a model for auto:${autoIntent} — connect a provider first`,
      );
    }
    log.info("CHAT", `Auto-routing "${modelStr}" → [${candidates.join(", ")}]`);
    return handleComboChat({
      body,
      models: candidates,
      handleSingleModel: withBreakerSuccess((b, m, sig) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, modelStr, resolveComboMemberAttemptCap(settings), sig || request?.signal)),
      log,
      comboName: modelStr,
      comboStrategy: "fallback",
      comboStickyLimit: settings.comboStickyRoundRobinLimit,
      signal: request?.signal,
      sessionId,
    });
  }

  // Check if model is a combo (has multiple models with fallback).
  // Strategy, capacity ordering, fusion and fallback dispatch all live
  // in comboDispatch.js (P4-33) — the same module the nested branch uses.
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    return dispatchCombo({
      body,
      comboName: modelStr,
      comboModels,
      settings,
      apiKey,
      keyAccess,
      requiredCapabilities,
      variants: await getInjectVariants().catch(() => ({})),
      clientRawRequest,
      request,
      log,
      sessionId,
      handleSingleModel: handleSingleModelChat,
      getCapacityConnections,
      recordBreakerSuccess: true,
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  // Same variant rules as the combo branches: a pool model that names a variant
  // is judged by its backing model, and carries its bare name so its prompt fires.
  const { memberInjectName: soloInjectName, variantBacking: soloVariantBacking } =
    createVariantHelpers(await getInjectVariants().catch(() => ({})), modelStr);
  const soloAugmented = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings, soloVariantBacking), [modelStr]);
  // A capability probe from the dashboard measures ONE model. The capacity
  // adapter would prepend a pool model and the probe would report the pool's
  // vision instead of the tested model's — the dashboard then shows a green
  // "image OK" for a model that never saw the image.
  const isCapabilityProbe = clientRawRequest?.headers?.["x-9r-capability-probe"] === "1";
  if (soloAugmented.length > 1 && !isCapabilityProbe) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        withBreakerSuccess(
          (b, m, sig) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, soloInjectName(m), resolveComboMemberAttemptCap(settings), sig || request?.signal),
          (m) => soloVariantBacking(m) || m,
        ),
        adapterAdded,
        soloVariantBacking
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
      signal: request?.signal,
    });
  }

  const soloResult = await handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null, null, null, request?.signal);
  try {
    if (soloResult?.ok) {
      const target = soloVariantBacking(modelStr) || modelStr;
      const p = parseModel(target);
      if (p?.provider) recordProviderSuccess(p.provider, p.model);
    }
  } catch { /* breaker bookkeeping must not fail the request */ }
  return soloResult;
}

/**
 * Tag a response that only succeeded after Anti-Flaky retries, so the
 * recovery is observable to the client. Never throws.
 */
function withFlakyRetriesHeader(response, retries) {
  try {
    const headers = new Headers(response.headers);
    headers.set("x-t-router-flaky-retries", String(retries));
    headers.set("x-9router-pro-flaky-retries", String(retries));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return response;
  }
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, requestedModel = null, injectModelName = null, comboMemberAttemptCap = null, abortSignal = null, pinnedConnectionId = null) {
  // One abort path for every branch. The solo and adapter branches pass the
  // raw request's signal; comboDispatch passes nothing positional, so the
  // request fallback covers it. Without this the account loop, the proxy
  // rotation and the upstream fetch all keep running after the client left.
  const signal = abortSignal || request?.signal || null;
  // Direct variant pick without a backing combo: a bare name that names a
  // variant routes straight to its backing model, with the variant name
  // carried so its prompt still fires. This covers both direct picks and
  // combo members that name variants — no combo object is created per
  // variant, so the Kombinasi page shows only combos the user made.
  if (typeof modelStr === "string" && !modelStr.includes("/")) {
    const directVariants = await getInjectVariants().catch(() => ({}));
    const directVariant = directVariants[modelStr];
    if (directVariant && typeof directVariant.model === "string" && directVariant.model.includes("/")) {
      // A direct pick used to run through its single-member combo, so it
      // inherited the member attempt cap; without it the pick grinds the
      // whole pool (a dahl direct pick timed out at 150s). Resolve the
      // cap here when the caller passed none (top-level picks pass null).
      const directCap = comboMemberAttemptCap ?? resolveComboMemberAttemptCap(await getSettings().catch(() => ({})));
      return handleSingleModelChat({ ...body, model: directVariant.model }, directVariant.model, clientRawRequest, request, apiKey, requestedModel, modelStr, directCap, signal, pinnedConnectionId);
    }
  }
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      // Nested combo (a combo member that is itself a combo): the access
      // decision was made on the outer target; only drop adapter models
      // the key may not call. One deliberate difference from the
      // top-level branch is preserved: no breaker-success recording
      // (recordBreakerSuccess: false) — see comboDispatch.js.
      // Variant fallback: a member that names a variant carries its own
      // bare name; otherwise the outer requested name is kept, so the
      // variant pick's prompt still fires. That is why the fallback
      // name here is (injectModelName || modelStr), not modelStr.
      const chatSettings = await getSettings();
      const nestedSession = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
      return dispatchCombo({
        body,
        comboName: modelStr,
        comboModels,
        settings: chatSettings,
        apiKey,
        keyAccess: await getKeyAccessContext(request),
        requiredCapabilities: detectRequiredCapabilities(body),
        variants: await getInjectVariants().catch(() => ({})),
        variantFallbackName: injectModelName || modelStr,
        clientRawRequest,
        request,
        log,
        sessionId: nestedSession?.sessionId || null,
        handleSingleModel: handleSingleModelChat,
        getCapacityConnections,
        recordBreakerSuccess: false,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  const allowDisabled = clientRawRequest?.headers?.["x-allow-disabled"] === "1";
  if (!allowDisabled && await isModelDisabled(modelStr)) {
    log.warn("CHAT", `Model "${modelStr}" is disabled`);
    return errorResponse(HTTP_STATUS.NOT_FOUND, `Model "${modelStr}" is disabled`);
  }

  // Per-provider/per-model cap override (P3-30): the caller passes the
  // global cap, but the member that actually serves is this provider/
  // model, so its override wins here. A null incoming cap means the
  // caller deliberately runs uncapped (solo single-model requests) and
  // stays null — the override only refines a cap that already exists.
  // The fresh settings read also covers direct-variant recursion, where
  // the caller resolved the cap before the backing model was known.
  if (comboMemberAttemptCap !== null) {
    comboMemberAttemptCap = resolveComboMemberAttemptCap(
      await getSettings().catch(() => ({})),
      provider,
      model,
    );
  }

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;
  // Anti-Flaky Guard (9Router Pro): retries spent on 200-but-garbage
  // responses, plus the last such response as a rescue if the pool runs
  // out before a clean answer shows up.
  let flakyAttempts = 0;
  let lastFlakyResult = null;
  // Smart member failover: failed accounts for this member inside this one
  // request. Once the cap is hit, the member gives up so the combo can move
  // to its next member at once instead of grinding the whole pool.
  let memberFallbackFailures = 0;

  while (true) {
    if (signal?.aborted) {
      // 499, not 503: the client is gone, so this member did not fail — a 503 makes
      // the combo read a departed caller as an upstream outage and burn the rest of
      // the rotation on members that abort instantly too. combo.js stops on 499.
      log.warn("CHAT", `[${provider}/${model}] client aborted, stopping account loop`);
      return errorResponse(499, "Request aborted by client");
    }
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { requestedModel: requestedModel || model, preferredConnectionId: pinnedConnectionId || undefined });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      // Anti-Flaky rescue: a flaky 200 we already hold beats an error.
      if (lastFlakyResult) return withFlakyRetriesHeader(lastFlakyResult.response, flakyAttempts);
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    // Prompt Injection (T Router / Pro): global → the API key's → the
    // variant's (matched by the bare custom name the user requested) →
    // the model+key's (matched by resolved provider/model). A variant
    // pick suppresses the model scopes, so the raw model name is never
    // disturbed by an injection.
    // Fail-open: resolvePromptInjectionMeta already swallows storage errors.
    const injectKeyRecord = apiKey ? await getApiKeyByKey(apiKey).catch(() => null) : null;
    const apiKeyId = injectKeyRecord?.id || null;
    let injectMeta = null;
    let promptInjects = [];
    try {
      injectMeta = await resolvePromptInjectionMeta({
        apiKeyId,
        requestedModel: injectModelName || requestedModel || modelStr,
        resolvedModel: `${provider}/${model}`,
        bareModel: model,
      });
      promptInjects = Array.isArray(injectMeta?.stack) ? injectMeta.stack : [];
    } catch {
      promptInjects = [];
    }
    if (promptInjects.length > 0) {
      const isVariantPick = Boolean(injectMeta?.isVariantPick);
      Promise.all([
        getInjectKeyModelPrompts().catch(() => ({})),
      ]).then(([keyModelMap]) => {
        const keyScopedNames = apiKeyId && keyModelMap?.[apiKeyId] ? Object.keys(keyModelMap[apiKeyId]) : [];
        const classified = classifyInjectStack(promptInjects, { apiKeyId, isVariantPick, keyModelNames: keyScopedNames });
        recordPromptInjectFire(classified);
      }).catch(() => {});
    }
    // R7 locked sampling: a direct variant pick (or a combo member naming
    // a variant) carries that variant's sampling params, overriding the
    // client's defaults for this request only. Prompt text untouched.
    const variantSampling = await resolveVariantSampling(injectModelName || requestedModel || modelStr).catch(() => null);
    // Brief Mode (9Router Pro): per-scope terseness level, same context.
    const briefLevel = await resolveBriefLevel({
      apiKeyId: injectKeyRecord?.id || null,
      requestedModel: injectModelName || requestedModel || modelStr,
      resolvedModel: `${provider}/${model}`,
      bareModel: model,
    });
    const result = await handleChatCore({
      body: applyVariantSampling({ ...body, model: `${provider}/${model}` }, variantSampling),
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      externalSignal: signal,
      requestId: clientRawRequest?.requestId || null,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      promptInjects,
      briefLevel,
      onRtkStats: (stats) => { try { recordRtkSavings(stats); } catch {} },
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Per-provider user overrides (custom headers / connect timeout) from settings
      providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    if (result.success) {
      // Peek stream for actual content before committing 200 headers to client.
      // If the connection drops or returns empty before tokens start flowing,
      // failover to the next active account seamlessly.
      if (body?.stream === true && result.response?.body) {
        let peeked = null;
        try {
          peeked = await peekStreamForContent(result.response.body, { deadlineMs: EMPTY_PEEK_DEADLINE_MS });
        } catch (peekErr) {
          log.warn("STREAM_PEEK", `[${provider}/${model}] stream peek threw: ${peekErr?.message || peekErr}`);
        }

        if (peeked && peeked.outcome === "empty" && !isNoRetryFinish(peeked.finishReason)) {
          log.warn("STREAM_PEEK", `[${provider}/${model}] account ${credentials.connectionName || credentials.connectionId} stream died or ended empty (${peeked.finishReason || "empty"}) — rotating to next account`);
          excludeConnectionIds.add(credentials.connectionId);
          lastError = `Stream ended empty (${peeked.finishReason || "disconnected"})`;
          lastStatus = HTTP_STATUS.BAD_GATEWAY;
          memberFallbackFailures++;
          if (comboMemberAttemptCap !== null && memberFallbackFailures >= comboMemberAttemptCap) {
            log.warn("COMBO", `Member ${provider}/${model} failed ${memberFallbackFailures} accounts — moving to next combo member`);
            return result.response;
          }
          continue;
        }

        if (peeked) {
          result.response = new Response(reconstructStream(peeked.head, peeked.reader, peeked.pendingRead), {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
          });
        }
      }

      // Anti-Flaky Guard (9Router Pro): an HTTP 200 whose body is empty
      // or a degenerate repetition loop is retried on another account
      // instead of reaching the client. Fail-open: retries are capped by
      // settings, the account is NOT marked unavailable (the upstream
      // pool is flaky, the key is not necessarily bad), and the last
      // flaky response is rescued above if the pool runs out.
      const afConfig = resolveAntiFlakyConfig(chatSettings);
      if (afConfig.enabled && afConfig.maxRetries > 0) {
        // Streaming clients get the light probe (never held up);
        // document-style requests are judged whole — some executors
        // deliver them as a live stream carrying a single JSON body.
        const verdict = body?.stream === true
          ? await inspectChatResponse(result.response)
          : await inspectChatResponseFull(result.response);
        if (verdict.flaky) {
          lastFlakyResult = result;
          if (flakyAttempts < afConfig.maxRetries) {
            flakyAttempts++;
            // A flaky retry spends an account attempt too (the account
            // did serve, just garbage), so it counts toward the member
            // cap — otherwise a member could burn its cap on hard
            // failures plus up to maxRetries extra flaky retries. When
            // the cap is hit the member gives up and the last flaky
            // response is rescued, the same way it is when the pool
            // runs out.
            memberFallbackFailures++;
            if (comboMemberAttemptCap !== null && memberFallbackFailures >= comboMemberAttemptCap) {
              log.warn("COMBO", `Member ${provider}/${model} failed ${memberFallbackFailures} accounts in this request — moving to next combo member`);
              return withFlakyRetriesHeader(result.response, flakyAttempts);
            }
            log.warn("FLAKY", `[${provider}/${model}] ${verdict.reason} response from ${credentials.connectionName || credentials.connectionId} — retry ${flakyAttempts}/${afConfig.maxRetries} on another account`);
            excludeConnectionIds.add(credentials.connectionId);
            lastError = `Flaky (${verdict.reason}) response`;
            lastStatus = HTTP_STATUS.BAD_GATEWAY;
            continue;
          }
          log.warn("FLAKY", `[${provider}/${model}] ${verdict.reason} response — retries exhausted, passing through`);
        }
      }
      return flakyAttempts > 0 ? withFlakyRetriesHeader(result.response, flakyAttempts) : result.response;
    }

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    let shouldFallback;
    if (provider === "antigravity" && quotaResetMs) {
      shouldFallback = true;
    } else {
      try {
        shouldFallback = (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;
      } catch (err) {
        // Fail open: bookkeeping must never kill the request — fall back to
        // the next account even if the lock could not be recorded.
        log.warn("FALLBACK", `markAccountUnavailable threw, falling back anyway: ${err?.message || err}`);
        shouldFallback = true;
      }
    }

    if (shouldFallback) {
      log.warn("FALLBACK", `${credentials.connectionName} failed (${result.status}${log.describeStatus?.(result.status) ? ` ${log.describeStatus(result.status)}` : ""}) → trying next account`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      // Smart member failover: a lane whose accounts keep failing (e.g. a
      // campaign-wide 429) stops here — the combo moves to its next member
      // at once instead of grinding the rest of this pool.
      memberFallbackFailures++;
      if (comboMemberAttemptCap !== null && memberFallbackFailures >= comboMemberAttemptCap) {
        log.warn("COMBO", `Member ${provider}/${model} failed ${memberFallbackFailures} accounts in this request — moving to next combo member`);
        return result.response;
      }
      continue;
    }

    return result.response;
  }
}

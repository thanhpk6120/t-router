import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { effectiveTimeoutLadder, ladderToTimeoutsMs, ttftRetryDelayMs } from "../services/timeoutLadder.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { gateFirstToken } from "../utils/ttftGate.js";
import { stableJsonStringify } from "../utils/stableJson.js";
import { dbg } from "../utils/debugLog.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses" ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, providerOverrides = null, directFetch = null }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};
    const forceFreshSocketByUrl = {};

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    // response (optional) lets a subclass hook compute a dynamic delay (e.g. antigravity Retry-After).
    const tryRetry = async (urlIndex, statusKey, reason, response = null) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      // Hook: subclass may derive delay from the response (headers/body). null → skip retry, use fallback.
      let waitMs = delayMs;
      if (response && this.computeRetryDelay) {
        const dynamic = await this.computeRetryDelay(response, retryAttemptsByUrl[urlIndex] + 1, delayMs);
        if (dynamic === false) return false; // hook vetoes retry (e.g. Retry-After too long)
        if (dynamic != null) waitMs = dynamic;
      }
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${waitMs / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return true;
    };

    // Per-provider TTFT ladder (seconds) — null means the feature is off and the
    // single FETCH_CONNECT_TIMEOUT_MS wait is used, i.e. today's behaviour.
    // See docs/resilience/per-provider-timeout-ladder.md.
    const ladderMs = ladderToTimeoutsMs(effectiveTimeoutLadder(providerOverrides, log));
    const ladderDelayMs = ttftRetryDelayMs();

    // The ladder retries the SAME url/account, so it is the inner loop; urlIndex
    // (fallback base URL) stays the outer loop and the ladder restarts per URL.
    outer: for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      const headers = this.buildHeaders(credentials, stream, url, model, transformedBody);
      // User per-provider override wins over registry headers (blocked names filtered at the API)
      if (providerOverrides?.headers) Object.assign(headers, providerOverrides.headers);

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      for (let step = 0; ; step++) {
      // Abort if upstream doesn't return response headers within connection timeout
      const connectCtrl = new AbortController();
      // Ladder rung for this attempt; past the last rung (only reachable when the
      // ladder is off) fall back to the single configured connect timeout.
      const timeoutMs = step < ladderMs.length ? ladderMs[step] : (this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS);
      // The rung budget is measured from HERE and covers headers AND the first
      // token. A streaming upstream answers headers in ~100ms and then thinks,
      // so a header-only deadline never fires and the ladder is inert.
      const attemptStart = Date.now();
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        // Stable key order so the same logical request always serializes to
        // the same bytes — keeps upstream prefix caching alive (see
        // utils/stableJson.js). Semantics match JSON.stringify.
        const bodyStr = stableJsonStringify(transformedBody);
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${bodyStr.length}B | connectTimeout=${timeoutMs}ms`);
        const effectiveProxyOptions = forceFreshSocketByUrl[urlIndex]
          ? { ...(proxyOptions || {}), forceFreshSocket: true }
          : proxyOptions;
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal,
          // Carries this provider's connect timeout into the proxy rotation so
          // the whole proxy phase is sized from the real per-attempt budget
          // (e.g. qoder's 120s) instead of the 60s global default.
          connectTimeoutMs: timeoutMs,
          // Protocol adapters that need their own transport (opencode's TLS
          // fingerprint) override the direct path; proxies still take priority.
          ...(directFetch ? { directFetch } : {}),
        }, effectiveProxyOptions);
        clearTimeout(connectTimer);
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`, response)) {
          // A 502 from an edge is typically a poisoned keep-alive socket — retry fresh.
          if (response.status === HTTP_STATUS.BAD_GATEWAY) forceFreshSocketByUrl[urlIndex] = true;
          urlIndex--;
          continue outer;
        }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue outer;
        }

        // Only a configured ladder gates the first token: with the feature off,
        // "headers arrived" stays the whole success criterion (today's
        // behaviour) and no body read is added to the hot path.
        const isOkResponse = response.ok ?? (response.status >= 200 && response.status < 300);
        if (ladderMs.length > 0 && isOkResponse) {
          const remainingMs = timeoutMs - (Date.now() - attemptStart);
          const gated = await gateFirstToken(response, remainingMs, {
            provider: this.provider,
            rung: step + 1,
            totalRungs: ladderMs.length,
            log,
          });
          return { response: gated, url, headers, transformedBody };
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        clearTimeout(connectTimer);
        lastError = error;

        // A rung that expired before the first token is a RETRY, not a failure:
        // advance to the next rung, or hand over to the fallback URL when the
        // ladder is spent. Nothing about the account changed, so no breaker or
        // quota state is touched here.
        if (error?.ttftRungExhausted) {
          if (step + 1 < ladderMs.length) {
            log?.debug?.("TTFT", `${this.provider} rung ${step + 1}/${ladderMs.length} expired (${timeoutMs}ms) — retrying same account with ${ladderMs[step + 1]}ms`);
            forceFreshSocketByUrl[urlIndex] = true;
            if (ladderDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, ladderDelayMs));
            continue;
          }
          if (urlIndex + 1 < fallbackCount) {
            log?.debug?.("TTFT", `${this.provider} ladder exhausted at ${url}, trying fallback ${urlIndex + 1}`);
            continue outer;
          }
          throw error;
        }
        // `connectCtrl.abort(new Error("fetch connect timeout"))` (and proxyFetch's
        // candidateCtrl) surface a plain `Error` (name === "Error"), whereas some
        // mocks reject with `AbortError`. Gate on the signal itself — unless the
        // caller's own signal aborted, which means the client cancelled.
        const isConnectTimeout = connectCtrl.signal.aborted && !signal?.aborted;
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        // Caller abort must propagate immediately regardless of abort reason.
        if (signal?.aborted || (error.name === "AbortError" && !isConnectTimeout)) throw error;

        // Ladder branch: headers never arrived within this rung and a rung is
        // left. Retry the SAME url with the SAME credentials — this is the
        // whole point of the feature, and the reason the generic connect-
        // timeout fast-fail below is gated on `!ladder retried`.
        // Nothing here touches account state, the breaker, or quota: a slow
        // account is not a dead account.
        if (isConnectTimeout && step + 1 < ladderMs.length) {
          log?.debug?.("TTFT", `${this.provider} connect timeout at rung ${step + 1}/${ladderMs.length} (${timeoutMs}ms) — retrying same account with ${ladderMs[step + 1]}ms`);
          // The keep-alive socket that just timed out is very likely dead.
          forceFreshSocketByUrl[urlIndex] = true;
          if (ladderDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, ladderDelayMs));
          continue;
        }

        // A connect timeout means NO headers arrived within the budget. The
        // abort reason carries the exact message (AbortSignal.any propagates
        // the first abort reason, so this surfaces as Error, not AbortError).
        // Retrying the SAME url would just burn another full budget per
        // retry — 4 x 60s + delays = ~250s per request, exactly the
        // tokenjuice signature of 2026-11-02 — while the combo / client
        // retry layers are the proper fallback. Fail this attempt fast; a
        // different fallback URL (if any) is still tried below.
        // Gate on the abort signal itself, not on the message string: the
        // timer is the only thing that aborts connectCtrl, so signal.aborted
        // is true exactly for connect timeouts even when the surfaced error
        // is a generic AbortError instead of "fetch connect timeout".
        const isFetchConnectTimeout = connectCtrl.signal.aborted;
        if (!isFetchConnectTimeout && await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, `network "${error.message}"`)) {
          forceFreshSocketByUrl[urlIndex] = true;
          urlIndex--;
          continue outer;
        }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue outer;
        }
        throw error;
      }
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;

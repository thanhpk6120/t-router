import { Readable } from "stream";
import {
  MEMORY_CONFIG,
  FETCH_CONNECT_TIMEOUT_MS,
  FRESH_RETRY_KEEPALIVE_TIMEOUT_MS,
  STALE_SOCKET_ERROR_CODES,
  NON_STALE_SOCKET_ERROR_CODES,
  STALE_SOCKET_ERROR_SUBSTRINGS,
  resolveKeepAliveTimeouts,
  isFreshSocketReplayEnabled,
} from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";
import { ensureClaudeCliVersion, applyClaudeCliVersion } from "./claudeCliVersion.js";

const CLAUDE_UA_PROBE = /claude-cli\/\d/;
function hasClaudeCliHeader(headers) {
  if (!headers) return false;
  const values = headers instanceof Headers ? [...headers.values()] : Array.isArray(headers) ? headers.map((h) => h[1]) : Object.values(headers);
  return values.some((v) => typeof v === "string" && CLAUDE_UA_PROBE.test(v));
}

export function isStaleSocketError(error) {
  if (!error || error.name === "AbortError" || isTlsCertError(error)) return false;
  const code = error?.cause?.code || error?.code || "";
  if (NON_STALE_SOCKET_ERROR_CODES.has(code)) return false;
  if (STALE_SOCKET_ERROR_CODES.has(code)) return true;
  const msg = `${error?.message || ""} ${error?.cause?.message || ""}`.toLowerCase();
  return STALE_SOCKET_ERROR_SUBSTRINGS.some((sub) => msg.includes(sub));
}

// Always fetch through the package's own undici instance so fetch and the
// Agents below come from the same copy — dispatcher options are only guaranteed
// to match within one undici version.
let undiciFetch = null;
async function rawFetch(url, options) {
  undiciFetch ??= (await import("undici")).fetch;
  return undiciFetch(url, options);
}

// Only a *patched instance of this module* is unsafe to call back into: the
// chain patchedFetch -> proxyAwareFetch -> fetchWithTlsFallback -> patchedFetch
// recurses until the stack overflows, and after a dev hot-reload the global
// holds a different instance's patchedFetch, so an identity check against the
// local function is not enough. Every patchedFetch carries this tag instead.
// Any other function on globalThis.fetch (a test mock, an undici install,
// another library's wrapper) is real I/O and is used as-is.
function isOwnPatchedFetch(fn) {
  return typeof fn === "function" && fn.__trouterProxyPatched === true;
}

// Resolved at call time, not module load: tests replace globalThis.fetch
// after import, and a cached reference would bypass the mock.
const systemFetch = globalThis.__trouterSystemFetch || (typeof globalThis.fetch === "function" && !isOwnPatchedFetch(globalThis.fetch) ? globalThis.fetch : undefined);
if (!globalThis.__trouterSystemFetch && systemFetch) {
  globalThis.__trouterSystemFetch = systemFetch;
}

function resolveBaseFetch() {
  const g = globalThis.fetch;
  if (g && g !== systemFetch && !isOwnPatchedFetch(g)) {
    return g;
  }
  return rawFetch;
}

resolveBaseFetch();
const proxyDispatchers = new Map();
const directDispatchers = new Map();

export function resetDirectDispatchersForTests() {
  directDispatchers.clear();
  proxyDispatchers.clear();
}

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const TLS_CERT_ERRORS = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function isTlsCertError(err) {
  const code = err?.cause?.code || err?.code;
  return TLS_CERT_ERRORS.has(code);
}
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

/** scheme://host:port only — never credentials. */
function safeProxyHost(proxyUrl) {
  try {
    const parsed = new URL(String(proxyUrl));
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "unparseable-proxy-url";
  }
}

/** Destination host only, never the full URL (which may carry a query/path). */
function safeTargetHost(url) {
  try {
    return new URL(typeof url === "string" ? url : url.toString()).host;
  } catch {
    return "unparseable-url";
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

const TLS_ECDH_CURVE = process.env.NINEROUTER_TLS_ECDH_CURVE || "X25519";
const EYEBALLS_CONNECT = { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 };
function buildConnectOptions(insecure) {
  return { ...EYEBALLS_CONNECT, ecdhCurve: TLS_ECDH_CURVE, ...(insecure ? { rejectUnauthorized: false } : {}) };
}

function evictOldest(cacheMap) {
  if (cacheMap.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
    const [oldKey, oldDispatcher] = cacheMap.entries().next().value || [];
    if (oldKey) {
      try {
        if (typeof oldDispatcher.close === "function") oldDispatcher.close();
        else if (typeof oldDispatcher.destroy === "function") oldDispatcher.destroy();
      } catch {}
      cacheMap.delete(oldKey);
    }
  }
}

async function getOrCreateDirectAgent(key, insecure, keepAliveTimeout, keepAliveMaxTimeout) {
  const cached = directDispatchers.get(key);
  if (cached) return cached;
  const { Agent } = await import("undici");
  evictOldest(directDispatchers);
  const agent = new Agent({
    connect: buildConnectOptions(insecure),
    keepAliveTimeout,
    keepAliveMaxTimeout,
  });
  directDispatchers.set(key, agent);
  return agent;
}

export function getDirectDispatcher(insecure = false) {
  const { keepAliveTimeout, keepAliveMaxTimeout } = resolveKeepAliveTimeouts();
  const key = `direct::${insecure ? "insecure" : "secure"}::${keepAliveTimeout}::${keepAliveMaxTimeout}`;
  return getOrCreateDirectAgent(key, insecure, keepAliveTimeout, keepAliveMaxTimeout);
}

export function getFreshRetryDispatcher(insecure = false) {
  const key = `fresh::${insecure ? "insecure" : "secure"}`;
  return getOrCreateDirectAgent(
    key,
    insecure,
    FRESH_RETRY_KEEPALIVE_TIMEOUT_MS,
    FRESH_RETRY_KEEPALIVE_TIMEOUT_MS
  );
}

/**
 * Create proxy or direct dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl, insecure = false, forceFreshSocket = false) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) {
    return forceFreshSocket ? getFreshRetryDispatcher(insecure) : getDirectDispatcher(insecure);
  }

  const key = `${normalized}::${insecure ? "insecure" : "secure"}`;
  if (!proxyDispatchers.has(key)) {
    evictOldest(proxyDispatchers);
    const { ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent({
      uri: normalized,
      connect: EYEBALLS_CONNECT,
      requestTls: { ecdhCurve: TLS_ECDH_CURVE, ...(insecure ? { rejectUnauthorized: false } : {}) },
    });
    proxyDispatchers.set(key, dispatcher);
  }

  return proxyDispatchers.get(key);
}
/**
 * Evict and close cached proxy dispatcher on IP rotation so keep-alive connections
 * don't remain pinned to the old exit IP.
 */
export function evictProxyDispatcher(proxyUrl) {
  if (!proxyUrl) return;
  const normalized = normalizeProxyUrl(proxyUrl);
  for (const [key, dispatcher] of proxyDispatchers.entries()) {
    if (key.startsWith(`${normalized || "direct"}::`)) {
      try {
        if (typeof dispatcher.close === "function") dispatcher.close();
        else if (typeof dispatcher.destroy === "function") dispatcher.destroy();
      } catch {}
      proxyDispatchers.delete(key);
    }
  }
  try {
    import(/* webpackIgnore: true */ "../services/opencodeTlsClient.js").then((m) => m.resetOpencodeTlsSession(proxyUrl)).catch(() => {});
  } catch {}
}

import { triggerBackgroundRotate, noteFailureRange, isProxyBadOrRefreshing } from "./proxyRotator.js";
export { triggerBackgroundRotate, noteFailureRange, isProxyBadOrRefreshing };

function isBodyReplaySafe(body) {
  return !(body && typeof body.getReader === "function" && body.locked);
}

async function fetchWithTlsFallback(url, options, proxyUrl, forceFreshSocket = false) {
  try {
    // Protocol adapters may need Node's HTTP/1 transport on the direct path,
    // or custom TLS impersonation (wreq-js) even when routed through a proxy.
    if (!proxyUrl && options.directFetch) return await options.directFetch(url, options);
    if (options.directFetch && options.proxyAwareDirectFetch) {
      return await options.directFetch(url, { ...options, _proxyUrl: proxyUrl }, proxyUrl);
    }
    const dispatcher = await getDispatcher(proxyUrl, false, forceFreshSocket);
    // Resolve at call time: a test may have replaced globalThis.fetch with a
    // mock after this module loaded, and only our own patched instances must
    // be skipped (see isOwnPatchedFetch).
    const callOptions = dispatcher ? { ...options, dispatcher, _proxyUrl: proxyUrl, _inProxyAware: true } : { ...options, _inProxyAware: true };
    return await resolveBaseFetch()(url, callOptions);
  } catch (err) {
    const isStrictSsl = options.strictTls === true || process.env.STRICT_SSL === "true" || process.env.STRICT_SSL === "1";
    if (!isStrictSsl && isTlsCertError(err)) {
      if (!isBodyReplaySafe(options.body)) {
        throw err;
      }
      // ponytail: in-memory insecure agent fallback for self-signed MITM corporate/antivirus certs
      console.warn(`[ProxyFetch] TLS cert verification failed (${err.cause?.code || err.code}), retrying with insecure TLS: ${url}`);
      const insecureDispatcher = await getDispatcher(proxyUrl, true, forceFreshSocket);
      return await resolveBaseFetch()(url, { ...options, dispatcher: insecureDispatcher, _proxyUrl: proxyUrl, _inProxyAware: true });
    }

    // Stale keep-alive recovery: a pooled socket died before returning headers. Replay
    // once on the fresh-socket dispatcher instead of waiting out the connect timeout.
    if (
      !proxyUrl
      && !forceFreshSocket
      && !options.directFetch
      && !options.signal?.aborted
      && isBodyReplaySafe(options.body)
      && isFreshSocketReplayEnabled()
      && isStaleSocketError(err)
    ) {
      dbg("FETCH", `stale keep-alive socket (${err.cause?.code || err.code || err.message}), retrying on fresh socket: ${url}`);
      return await fetchWithTlsFallback(url, options, proxyUrl, true);
    }
    throw err;
  }
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    // Every exit path clears the timer and detaches the abort listener so a
    // completed request never fires a late abort into a closed socket.
    let settled = false;
    let timer = null;
    const onAbort = () => finish(new Error("fetch connect timeout"));
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { options.signal?.removeEventListener?.("abort", onAbort); } catch {}
      try { socket.destroy(); } catch {}
      if (err) reject(err);
    };

    // This path bypasses undici entirely, so nothing else bounds it: without
    // these three timers a socket that connects but never answers holds the
    // request forever.
    const timeoutMs = options.connectTimeoutMs || 60000;
    timer = setTimeout(() => finish(new Error("fetch connect timeout")), timeoutMs);
    if (options.signal) {
      if (options.signal.aborted) return finish(new Error("aborted"));
      try { options.signal.addEventListener("abort", onAbort, { once: true }); } catch {}
    }
    socket.setTimeout(timeoutMs, () => finish(new Error("fetch connect timeout")));

    socket.connect(HTTPS_PORT, realIP, () => {
      const reqOptions = {
        socket,
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      const req = https.request(reqOptions, (res) => {
        if (settled) { try { res.destroy(); } catch {} return; }
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        try { options.signal?.removeEventListener?.("abort", onAbort); } catch {}
        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          json: async () => JSON.parse(await response.text()),
        };
        resolve(response);
      });

      req.setTimeout(timeoutMs, () => { try { req.destroy(new Error("fetch connect timeout")); } catch {} });
      req.on("error", (err) => finish(err));
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", (err) => finish(err));
  });
}

function isProxyActiveForProvider(proxyOptions) {
  if (!proxyOptions) return false;
  if (proxyOptions.proxyIntended === true) return true;
  if (proxyOptions.proxyIntended === false) return false;
  if (proxyOptions.source === "none") return false;

  const poolId = normalizeString(proxyOptions.proxyPoolId || proxyOptions.connectionProxyPoolId);
  const hasPoolId = !!poolId && poolId !== "__none__";
  const hasProxyUrl = !!normalizeString(proxyOptions.connectionProxyUrl || proxyOptions.url);
  const hasRelayUrl = !!normalizeString(proxyOptions.vercelRelayUrl);
  const isEnabled = proxyOptions.connectionProxyEnabled === true || proxyOptions.enabled === true;

  return hasPoolId || isEnabled || hasProxyUrl || hasRelayUrl;
}
export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  // Keep the spoofed Claude Code version current (new models require a minimum CLI version).
  // Refresh in the background: the request uses the version already known, so an
  // unreachable npm registry can never add latency to the chat path.
  if (hasClaudeCliHeader(options?.headers)) {
    void ensureClaudeCliVersion(rawFetch);
    options = { ...options, headers: applyClaudeCliVersion(options.headers) };
  }
  const targetUrl = typeof url === "string" ? url : url.toString();

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const baseHeaders = options.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : { ...(options.headers || {}) };
    const relayHeaders = {
      ...baseHeaders,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return resolveBaseFetch()(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;
  const forceFreshSocket = proxyOptions?.forceFreshSocket === true || options?.forceFreshSocket === true;

  // Protocol adapters that own their transport (wreq-js TLS impersonation)
  // cannot use an undici dispatcher: they must drive the proxy themselves.
  // Only adapters that declare `proxyCapable` opt in — any other adapter
  // ignores the proxy URL and would leave over the direct interface, so they
  // keep the undici path below.
  if (proxyUrl && options?.directFetch?.proxyCapable === true) {
    try {
      const res = await options.directFetch(url, { ...options, proxyUrl }, proxyUrl);
      // Reported only after the adapter that holds the tunnel returned.
      const via = res?.headers?.get?.("x-9r-proxy-via");
      dbg("PROXY", `PROXY ROUTING VERIFIED | ${safeTargetHost(targetUrl)} | transport=adapter | proxy=${via || safeProxyHost(proxyUrl)} | status=${res?.status}`);
      return res;
    } catch (err) {
      if (proxyOptions?.strictProxy === true) {
        throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${err.message}`);
      }
      throw err;
    }
  }

  const isProxyActive = isProxyActiveForProvider(proxyOptions);

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        return await fetchWithTlsFallback(url, options, proxyUrl, forceFreshSocket);
      } catch (proxyError) {
        if (proxyOptions?.strictProxy === true) {
          throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
        }
        if (isProxyActive && proxyOptions?.directActive === false) {
          throw new Error(`[ProxyFetch] Proxy failed and Direct connection is disabled in Proxy Pools. Refusing direct bypass to prevent IP leak: ${proxyError.message}`);
        }
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    // No proxy resolved
    if (isProxyActive && proxyOptions?.directActive === false) {
      throw new Error(`[ProxyFetch] Proxy is enabled for provider but none resolved, and Direct connection is disabled in Proxy Pools. Refusing direct MITM bypass to prevent IP leak.`);
    }
    // No proxy configured, or Direct fallback allowed — manually resolve real IP to bypass DNS spoof
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
    } catch (error) {
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  // Extract candidate proxies if available, otherwise construct from current single proxy
  let candidateList = [];
  if (Array.isArray(proxyOptions?.candidateProxies) && proxyOptions.candidateProxies.length > 0) {
    candidateList = proxyOptions.candidateProxies.filter(
      (p) => p && (p.proxyUrl || p.vercelRelayUrl) && p.id !== "direct" && p.proxyUrl !== "direct"
    );
  } else if (proxyUrl && proxyUrl !== "direct") {
    candidateList = [{
      proxyUrl,
      rotateLink: proxyOptions?.proxyPool?.rotateLink || proxyOptions?.proxyPool?.rotateUrl || proxyOptions?.rotateLink || "",
      noProxy: proxyOptions?.noProxy || proxyOptions?.connectionNoProxy || "",
      strictProxy: proxyOptions?.strictProxy === true,
      proxyPool: proxyOptions?.proxyPool || null,
      vercelRelayUrl: proxyOptions?.vercelRelayUrl || "",
    }];
  }

  // Sort candidate proxies: non-refreshing & non-bad exit ranges first
  if (candidateList.length > 1) {
    candidateList.sort((a, b) => {
      const aBad = isProxyBadOrRefreshing(a.proxyUrl);
      const bBad = isProxyBadOrRefreshing(b.proxyUrl);
      if (!aBad && bBad) return -1;
      if (aBad && !bBad) return 1;
      return 0;
    });
  }

  if (candidateList.length > 0) {
    let lastError = null;
    let lastResponse = null;

    // One budget for the whole proxy phase, sliced per candidate. Sharing the
    // caller's single connect signal made every candidate after the first
    // abort instantly (the pool never actually rotated); a fresh full 60s per
    // candidate would instead cost N×60s for one attempt. Split the same
    // budget so live candidates get a real chance and the phase as a whole
    // still ends inside the caller's connect timeout.
    // base.js passes the provider's own connect timeout in options; keep the
    // proxyOptions spelling for callers that set it there.
    const declaredConnectMs = Number.isFinite(options?.connectTimeoutMs)
      ? options.connectTimeoutMs
      : proxyOptions?.connectTimeoutMs;
    const phaseBudgetMs = Number.isFinite(declaredConnectMs) ? declaredConnectMs : FETCH_CONNECT_TIMEOUT_MS;
    const phaseDeadline = Date.now() + phaseBudgetMs;

    for (let i = 0; i < candidateList.length; i++) {
      const candidate = candidateList[i];
      const curProxyUrl = candidate.proxyUrl;
      const curRotateLink = candidate.rotateLink || candidate.proxyPool?.rotateLink || candidate.proxyPool?.rotateUrl || "";

      // Check noProxy for this candidate
      if (candidate.noProxy && shouldBypassByNoProxy(targetUrl, candidate.noProxy)) {
        continue;
      }

      // Per-candidate controller: one abort cannot poison the rest of the
      // pool, yet it stays chained to the caller's signal so a client abort
      // or the outer connect timeout still cancels the whole phase.
      const candidateCtrl = new AbortController();
      const onOuterAbort = () => { try { candidateCtrl.abort(new Error("aborted")); } catch { /* already */ } };
      if (options.signal) {
        if (options.signal.aborted) { try { candidateCtrl.abort(new Error("aborted")); } catch { /* already */ } }
        else { try { options.signal.addEventListener("abort", onOuterAbort, { once: true }); } catch { /* noop */ } }
      }
      // Slice what is left across the candidates that remain: handing the
      // first one the whole budget starves the rest and makes rotation a
      // no-op again, which is the bug this phase budget exists to avoid.
      const remaining = phaseDeadline - Date.now();
      const leftCandidates = Math.max(1, candidateList.length - i);
      const sliceMs = Math.max(5000, Math.floor(remaining / leftCandidates));
      const candidateBudgetMs = Math.min(remaining, sliceMs);
      const candidateTimer = setTimeout(() => {
        try { candidateCtrl.abort(new Error("fetch connect timeout")); } catch { /* already */ }
      }, Math.max(0, candidateBudgetMs));
      const candidateOptions = { ...options, signal: candidateCtrl.signal };
      // keepAbort=true keeps the outer-signal listener alive for a response we
      // are about to hand back: a client abort while the body is still
      // streaming must still cancel the upstream request (undici aborts the
      // body through this controller). Every other exit removes it so an
      // abandoned candidate cannot leak a listener for the whole request.
      const releaseCandidate = (keepAbort = false) => {
        clearTimeout(candidateTimer);
        if (!keepAbort) {
          try { options.signal?.removeEventListener?.("abort", onOuterAbort); } catch { /* noop */ }
        }
      };
      try {
        let res;
        if (candidate.vercelRelayUrl) {
          const parsed = new URL(targetUrl);
          const baseHeaders = options.headers instanceof Headers
            ? Object.fromEntries(options.headers.entries())
            : { ...(options.headers || {}) };
          const relayHeaders = {
            ...baseHeaders,
            "x-relay-target": `${parsed.protocol}//${parsed.host}`,
            "x-relay-path": `${parsed.pathname}${parsed.search}`,
          };
          res = await resolveBaseFetch()(candidate.vercelRelayUrl, { ...candidateOptions, headers: relayHeaders });
        } else {
          res = await fetchWithTlsFallback(url, candidateOptions, curProxyUrl, forceFreshSocket);
        }
        releaseCandidate(true);

        // If upstream or proxy rejected with 429/403/502/503 and has rotateLink
        if (res && (res.status === 429 || res.status === 403 || res.status === 502 || res.status === 503)) {
          if (curRotateLink) {
            triggerBackgroundRotate(curRotateLink, curProxyUrl, candidate.proxyPool || candidate);
          }
          // If there is another active candidate proxy in the pool, fallback to it!
          if (i + 1 < candidateList.length) {
            console.warn(`[ProxyFetch] Proxy HTTP ${res.status} on ${curProxyUrl}, falling back to next candidate proxy (${i + 2}/${candidateList.length})`);
            lastResponse = res;
            // This response is abandoned, not returned: cancel its body and
            // detach the outer abort chain before moving to the next proxy.
            try { candidateCtrl.abort(); } catch { /* already */ }
            releaseCandidate();
            continue;
          }
        }

        return res;
      } catch (proxyError) {
        releaseCandidate();
        lastError = proxyError;
        if (curRotateLink) {
          triggerBackgroundRotate(curRotateLink, curProxyUrl, candidate.proxyPool || candidate);
        }

        // Fallback to next candidate proxy if available
        if (i + 1 < candidateList.length && Date.now() < phaseDeadline) {
          const nextCandidate = candidateList[i + 1];
          const nextProxyUrl = nextCandidate.proxyUrl || nextCandidate.vercelRelayUrl;
          console.warn(`[ProxyFetch] Proxy failed (${proxyError.message}) on ${curProxyUrl}, falling back to next active proxy ${nextProxyUrl} (${i + 2}/${candidateList.length})`);
          continue;
        }
      }
    }

    // All candidate proxies in the pool were attempted and failed
    if (proxyOptions?.strictProxy === true) {
      throw new Error(`[ProxyFetch] All ${candidateList.length} proxies failed (strictProxy=true): ${lastError?.message || `HTTP ${lastResponse?.status}`}`);
    }
    if (isProxyActive && proxyOptions?.directActive === false) {
      throw new Error(`[ProxyFetch] All ${candidateList.length} active proxies failed and Direct connection is disabled in Proxy Pools. Refusing direct fallback to prevent IP leak: ${lastError?.message || `HTTP ${lastResponse?.status}`}`);
    }

    console.warn(`[ProxyFetch] All ${candidateList.length} active proxies failed, falling back to active Direct connection: ${lastError?.message || `HTTP ${lastResponse?.status}`}`);
    return fetchWithTlsFallback(url, options, null, forceFreshSocket);
  }
  // Strict mode means "never leave over the direct IP". Reaching here with a
  // proxy configured but unresolved is exactly that case — an inactive or
  // empty pool, or every proxy removed — so refuse instead of silently
  // exposing the real address (#4333). The catch blocks above only cover a
  // proxy that was actually tried.
  //
  // Gate on a proxy being *intended*: callers like the Qoder executor set
  // strictProxy to mean "do not replay this request directly if the proxy
  // fails" (a replayed COSY signature returns 403), not "a proxy is required".
  // With nothing configured they must keep working.
  if (proxyOptions?.strictProxy === true && isProxyActive) {
    throw new Error("[ProxyFetch] Proxy required but none resolved (strictProxy=true)");
  }
  if (isProxyActive && proxyOptions?.directActive === false) {
    throw new Error("[ProxyFetch] Proxy is enabled for provider but none resolved, and Direct connection is disabled in Proxy Pools. Refusing direct request to prevent IP leak.");
  }

  // Provider does not use proxy (or Direct connection is active) — use native fetch directly
  return fetchWithTlsFallback(url, options, null, forceFreshSocket);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  if (options?._inProxyAware) {
    const sys = globalThis.__trouterSystemFetch;
    if (typeof sys === "function") {
      return sys(url, options);
    }
  }
  return proxyAwareFetch(url, options, null);
}
// Tagged so a re-evaluated module, and any test that swaps globalThis.fetch,
// can tell our wrapper apart from real I/O. Untagged, resolveBaseFetch would
// treat this as the base fetch and recurse into proxyAwareFetch forever.
patchedFetch.__trouterProxyPatched = true;


// Idempotency guard — patch exactly once per process. The identity check
// below is insufficient under hot reload: the fresh module's patchedFetch
// differs from the previous instance's, so the guard passes again and the
// global is wrapped once more. A global flag survives re-evaluation.
if (!globalThis.__trouterProxyFetchPatched) {
  globalThis.__trouterProxyFetchPatched = true;
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;

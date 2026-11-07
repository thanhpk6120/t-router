import { ProxyAgent, fetch as undiciFetch } from "undici";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard";

const DEFAULT_TEST_URL = "https://google.com/";
const DEFAULT_TIMEOUT_MS = 8000;

function getErrorMessage(err) {
  if (!err) return "Unknown error";
  const base = err?.message || String(err);
  const causeCode = err?.cause?.code || err?.code;
  const causeMessage = err?.cause?.message;

  if (causeMessage && causeMessage !== base) {
    return causeCode ? `${base}: ${causeMessage} (${causeCode})` : `${base}: ${causeMessage}`;
  }

  if (causeCode && !base.includes(causeCode)) {
    return `${base} (${causeCode})`;
  }

  return base;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export async function testProxyUrl({ proxyUrl, testUrl, timeoutMs } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) {
    return { ok: false, status: 400, error: "proxyUrl is required" };
  }

  const normalizedTestUrl = normalizeString(testUrl) || DEFAULT_TEST_URL;
  const timeoutMsRaw = Number(timeoutMs);
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(timeoutMsRaw, 30000)
      : DEFAULT_TIMEOUT_MS;

  if (normalizedProxyUrl === "direct") {
    try {
      await assertPublicUrlResolved(normalizedTestUrl);
    } catch (ssrfErr) {
      return { ok: false, status: 400, error: ssrfErr.message || "SSRF check failed: target URL not allowed" };
    }
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);
    try {
      const res = await undiciFetch(normalizedTestUrl, {
        method: "HEAD",
        signal: controller.signal,
        headers: {
          "User-Agent": "TRouter",
        },
      });
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: normalizedTestUrl,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const isTimeout = err?.name === "AbortError" || controller.signal.aborted;
      return {
        ok: false,
        status: isTimeout ? 504 : 502,
        error: isTimeout ? `Direct test timed out after ${normalizedTimeoutMs}ms` : getErrorMessage(err),
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  let dispatcher;

  try {
    try {
      dispatcher = new ProxyAgent({ uri: normalizedProxyUrl });
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: `Invalid proxy URL: ${err?.message || String(err)}`,
      };
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);

    try {
      const res = await undiciFetch(normalizedTestUrl, {
        method: "HEAD",
        dispatcher,
        signal: controller.signal,
        headers: {
          "User-Agent": "TRouter",
        },
      });

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: normalizedTestUrl,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message =
        err?.name === "AbortError"
          ? "Proxy test timed out"
          : getErrorMessage(err);
      return { ok: false, status: 500, error: message };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
  }
}

// What the outside world sees when traffic leaves through a proxy. A pool that
// "passes" its health check can still be bypassed (or NAT to the server's own
// IP); the exit IP is the only direct proof of which proxy carried the request.
const IP_ECHO_URLS = [
  "https://api.ipify.org?format=json",
  "https://ifconfig.me/ip",
];

export async function probeExitIp({ proxyUrl, timeoutMs } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) {
    return { ok: false, error: "proxyUrl is required" };
  }
  if (normalizedProxyUrl === "direct") {
    return { ok: false, error: "Direct is not a proxy" };
  }

  const timeoutRaw = Number(timeoutMs);
  const budget = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 15000) : 8000;

  let dispatcher;
  try {
    try {
      dispatcher = new ProxyAgent({ uri: normalizedProxyUrl });
    } catch (err) {
      return { ok: false, error: `Invalid proxy URL: ${err?.message || String(err)}` };
    }

    let lastError = "";
    for (const url of IP_ECHO_URLS) {
      try {
        const res = await undiciFetch(url, {
          dispatcher,
          signal: AbortSignal.timeout(budget),
          headers: { "user-agent": "TRouter", accept: "application/json, text/plain" },
        });
        if (!res.ok) {
          lastError = `Exit-IP check returned ${res.status}`;
          continue;
        }
        const text = (await res.text()).trim();
        let ip = text;
        try {
          const parsed = JSON.parse(text);
          ip = parsed?.ip || parsed?.origin || text;
        } catch { /* plain-text endpoint */ }
        ip = String(ip).split(",")[0].trim();
        if (ip && /^[0-9a-fA-F.:]+$/.test(ip)) {
          return { ok: true, ip, source: url };
        }
        lastError = "Exit-IP check returned no address";
      } catch (err) {
        lastError = err?.name === "TimeoutError" || err?.name === "AbortError"
          ? `Exit-IP check timed out after ${budget}ms`
          : getErrorMessage(err);
      }
    }
    return { ok: false, error: lastError || "Exit-IP check failed" };
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
  }
}

// Relay pools (vercel/cloudflare/deno/netlify) are tested by asking the relay
// to fetch httpbin instead of routing through a ProxyAgent.
export async function testRelayUrl(relayUrl, timeoutMs = 10000) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(relayUrl, {
      method: "GET",
      headers: {
        "x-relay-target": "https://httpbin.org",
        "x-relay-path": "/get",
      },
      signal: controller.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.name === "AbortError" ? "Relay test timed out" : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

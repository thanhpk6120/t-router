/**
 * Proxy provenance for a single upstream response.
 *
 * Why this is its own module: it is the one thing the fetch layer and the
 * request-detail recorder must agree on, and it must NOT be reachable only
 * through proxyFetch.js — every test that mocks proxyFetch (there are dozens)
 * would then have to re-export it, and each new mock is a place to forget.
 * Keeping it standalone means `import { tagProxyUsed } from "./proxyProvenance"`
 * in proxyFetch and `import { getResponseProxyInfo }` in the recorder are both
 * immune to those mocks.
 *
 * The record answers "which proxy carried THIS request?" — which is not the
 * same as the configured proxy: the pool is chosen per attempt, and a failed
 * candidate rotates to the next one mid-request.
 */

const responseProxyInfo = new WeakMap();
const PROXY_INFO_KEY = "__trouterProxyInfo";

/**
 * Attach provenance to a Response. Stored in a WeakMap (a Response may be
 * cloned/wrapped by executors) plus a non-enumerable own property as a
 * fallback for the dev hot-reload case where this module is re-evaluated
 * while an older Response is still in flight.
 *
 * Never a header: headers reach the client, and this is operator telemetry.
 *
 * @param {Response} res
 * @param {object|null} info
 * @returns {Response}
 */
export function tagProxyUsed(res, info) {
  if (!res || typeof res !== "object") return res;
  const normalized = info && info.proxied ? info : { proxied: false, ...(info || {}) };
  try {
    responseProxyInfo.set(res, normalized);
  } catch { /* non-extensible target: the property below still carries it */ }
  if (!Object.prototype.hasOwnProperty.call(res, PROXY_INFO_KEY)) {
    try {
      Object.defineProperty(res, PROXY_INFO_KEY, {
        value: normalized,
        enumerable: false,
        configurable: true,
      });
    } catch { /* frozen Response — the WeakMap entry is enough */ }
  }
  return res;
}

/**
 * Provenance for a Response produced by proxyAwareFetch.
 *
 * Returns null when the response never passed through the tagging layer (a
 * mocked fetch in a test, or an executor that bypasses proxyAwareFetch). A
 * caller must treat null as "unknown" and omit the field — asserting "direct"
 * there would be a guess presented as a fact.
 *
 * @param {Response} res
 * @returns {{proxied: boolean, poolId?: string, poolName?: string, host?: string, type?: string, attempts?: number, candidateCount?: number, rotateLink?: boolean, fallbackDirect?: boolean, reason?: string}|null}
 */
export function getResponseProxyInfo(res) {
  if (!res || typeof res !== "object") return null;
  return responseProxyInfo.get(res) || res[PROXY_INFO_KEY] || null;
}

/** Test hook: forget all recorded provenance. */
export function resetProxyProvenanceForTests() {
  // WeakMap has no clear(); a fresh module instance is what tests get via
  // vi.resetModules(). Kept for API symmetry with the other reset helpers.
}

/**
 * Provenance for a request that never produced a Response — the fetch layer
 * threw (strictProxy, or direct disabled while every candidate failed).
 *
 * Without this the most interesting failure reads as "unknown" on the usage
 * page: the operator cannot tell "we died on the proxy" from "this executor
 * does not report proxies at all". Same WeakMap as responses; the two never
 * collide because a Response and an Error are different objects.
 *
 * @param {Error} error
 * @param {object} info
 * @returns {Error}
 */
export function tagProxyFailure(error, info) {
  if (!error || typeof error !== "object") return error;
  return tagProxyUsed(error, { proxied: false, ...(info || {}) });
}

/**
 * @param {Error} error
 * @returns {{proxied: boolean, fallbackDirect?: boolean, strictProxy?: boolean, candidateCount?: number, reason?: string}|null}
 */
export function getProxyFailureInfo(error) {
  if (!error || typeof error !== "object") return null;
  return getResponseProxyInfo(error);
}

/**
 * Rotate-on-status policy — which upstream statuses mean "this exit is spent,
 * move to the next proxy".
 *
 * These are the statuses that describe the EXIT rather than the request:
 *  - 429 quota/rate limit on this egress IP
 *  - 403 denial (Cloudflare / WAF blocks keyed on the exit)
 *  - 502 / 503 edge or upstream-proxy failure
 *
 * A 400/404/422 is the client's request being wrong. Rotating a whole pool over
 * a malformed body would burn healthy exits for nothing, so those are NOT in the
 * default set — an operator can still add them deliberately.
 *
 * Lives in config/ because both the engine (open-sse/utils/proxyFetch.js) and
 * the dashboard control (src/shared/components/NoAuthProxyCard.js) must agree on
 * exactly one parser and one default.
 */
export const DEFAULT_PROXY_ROTATE_STATUSES = [429, 403, 502, 503];

/**
 * Normalize an operator-supplied status list into a de-duplicated integer array.
 * Accepts `[429, 403]`, `"429,403"`, `"429 403"`, `"429;403"`, mixed types.
 * Anything outside 100–599 is dropped; an empty result falls back to the default
 * so a cleared input can never mean "never rotate".
 */
export function resolveProxyRotateStatuses(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,;]+/)
      : [];
  const nums = list
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599);
  const unique = [...new Set(nums)];
  return unique.length > 0 ? unique : DEFAULT_PROXY_ROTATE_STATUSES;
}

export default DEFAULT_PROXY_ROTATE_STATUSES;

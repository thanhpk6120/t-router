import { TTFT_TIMEOUT_MAX_MS, TTFT_LADDER_MAX_LEN } from "open-sse/config/runtimeConfig.js";

// Validation at the trust boundary — the UI also validates, but this is the gate.
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE_LENGTH = 8192;
// RFC 7230 token subset: letters, digits, hyphen (no spaces, no unicode)
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
// Request-structure / auth headers a user override must never touch
const BLOCKED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "authorization",
  "cookie",
]);

/**
 * Validate + normalize an override payload. Returns { override } or { error }.
 * An override with no fields is normalized to null (= delete).
 */
export function normalizeOverride({ headers, timeoutLadder }) {
  const out = {};

  if (headers !== undefined && headers !== null) {
    if (typeof headers !== "object" || Array.isArray(headers)) {
      return { error: "headers must be an object" };
    }
    const entries = Object.entries(headers).filter(([, v]) => v !== "" && v != null);
    if (entries.length > MAX_HEADERS) {
      return { error: `Too many headers (max ${MAX_HEADERS})` };
    }
    const clean = {};
    for (const [name, value] of entries) {
      if (!HEADER_NAME_RE.test(name)) {
        return { error: `Invalid header name: ${name}` };
      }
      if (typeof value !== "string" || /[\r\n]/.test(value)) {
        return { error: `Invalid value for header ${name}` };
      }
      if (value.length > MAX_HEADER_VALUE_LENGTH) {
        return { error: `Header ${name} value too long (max ${MAX_HEADER_VALUE_LENGTH})` };
      }
      if (BLOCKED_HEADERS.has(name.toLowerCase())) {
        return { error: `Header ${name} cannot be overridden` };
      }
      clean[name] = value;
    }
    if (Object.keys(clean).length) out.headers = clean;
  }

  if (timeoutLadder !== undefined && timeoutLadder !== null) {
    if (!Array.isArray(timeoutLadder)) {
      return { error: "timeoutLadder must be an array of seconds" };
    }
    // Empty array is the documented "feature off" value, matching an empty
    // headers object: it deletes the field instead of storing [].
    if (timeoutLadder.length > 0) {
      if (timeoutLadder.length > TTFT_LADDER_MAX_LEN) {
        return { error: `Too many ladder steps (max ${TTFT_LADDER_MAX_LEN})` };
      }
      const maxSeconds = Math.round(TTFT_TIMEOUT_MAX_MS / 1000);
      const clean = [];
      for (const step of timeoutLadder) {
        if (!Number.isInteger(step) || step <= 0) {
          return { error: "Each ladder step must be a positive whole number of seconds" };
        }
        // 400 rather than clamp: a rung above the combo's first-response budget
        // would be aborted by the combo before the ladder could climb, so the
        // operator must see that the value cannot work instead of silently
        // getting a different ladder than they typed.
        if (step > maxSeconds) {
          return { error: `Ladder step ${step}s exceeds the ${maxSeconds}s maximum` };
        }
        clean.push(step);
      }
      out.timeoutLadder = clean;
    }
  }

  return { override: Object.keys(out).length ? out : null };
}

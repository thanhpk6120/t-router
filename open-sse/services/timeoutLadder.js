// Per-provider TTFT timeout ladder — pure helpers.
//
// Design: docs/resilience/per-provider-timeout-ladder.md
//
// A ladder is an array of seconds. Its LENGTH is the number of attempts, so
// `[5]` means one 5s attempt (not "one 60s attempt plus a 5s retry"). The array
// is deliberately NOT sorted and NOT required to increase: `[5,30,10]` means
// "wait 5s, then 30s, then 10s" and that is a legitimate operator choice.
//
// These helpers are pure and import only config constants, so tests do not drag
// in BaseExecutor → proxyFetch → the whole network stack.

import { TTFT_TIMEOUT_MAX_MS, TTFT_LADDER_MAX_LEN, TTFT_RETRY_DELAY_MS } from "../config/runtimeConfig.js";

/**
 * Validate a raw ladder value and return the accepted array (seconds), or null.
 *
 * Rejects the WHOLE array on the first invalid rung instead of silently dropping
 * it: a partially-honoured ladder would leave the operator with fewer attempts
 * than they configured and no signal. The API route rejects the same shapes with
 * a 400 at the trust boundary, so this path only sees hand-edited DB rows.
 *
 * @param {unknown} value
 * @returns {number[] | null} seconds, clamped + truncated; null = feature off
 */
export function normalizeTimeoutLadder(value) {
  if (!Array.isArray(value) || value.length === 0) return null;

  const out = [];
  for (const entry of value) {
    // Integers only. `5.5` or `"5"` are operator mistakes, not values to coerce —
    // a coerced string would turn `["10"]` into a 10s rung with no validation.
    if (!Number.isInteger(entry) || entry <= 0) return null;
    // Clamp, do not reject: a rung above the cap is still a usable "as long as
    // we are willing to wait" value, and rejecting here would disable the whole
    // feature for a value the API already blocks.
    out.push(Math.min(entry, Math.round(TTFT_TIMEOUT_MAX_MS / 1000)));
    if (out.length >= TTFT_LADDER_MAX_LEN) break;
  }

  return out.length ? out : null;
}

/**
 * Ladder configured for this provider, or null when the feature is off.
 *
 * @param {{ timeoutLadder?: unknown } | null | undefined} providerOverrides
 * @param {{ warn?: Function } | null} [log] optional logger for rejected input
 * @returns {number[] | null} seconds
 */
export function effectiveTimeoutLadder(providerOverrides, log = null) {
  const raw = providerOverrides?.timeoutLadder;
  if (raw == null) return null;

  const ladder = normalizeTimeoutLadder(raw);
  if (!ladder && log?.warn) {
    log.warn("TTFT", `ignoring invalid timeoutLadder: ${JSON.stringify(raw)}`);
  }
  return ladder;
}

/**
 * Convert a seconds ladder into the per-attempt millisecond budgets the executor
 * arms its connect timer with. Kept separate from `effectiveTimeoutLadder` so the
 * executor never does unit math inline.
 *
 * @param {number[] | null} ladder seconds
 * @returns {number[]} milliseconds, empty when the feature is off
 */
export function ladderToTimeoutsMs(ladder) {
  if (!Array.isArray(ladder) || ladder.length === 0) return [];
  return ladder.map((seconds) => Math.min(seconds * 1000, TTFT_TIMEOUT_MAX_MS));
}

/** Pause between two ladder attempts, in ms. 0 disables the pause. */
export function ttftRetryDelayMs() {
  return TTFT_RETRY_DELAY_MS;
}

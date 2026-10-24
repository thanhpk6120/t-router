// Balanced selection (T Router): health tiers keep recently-failed
// accounts in reserve without deleting them, the windowed LRU pick spreads
// load without a deterministic hot spot, and the "unavailable" dashboard
// label is gated on a substantial cooldown so short transients cannot
// brand a healthy key as dead (the misreading that once made ~17.7k live
// dahl keys look like a dead fleet).
import { describe, expect, it } from "vitest";
import {
  connectionHealthTier,
  pickWindowedLru,
  shouldStampUnavailable,
  lastUsedOverlay,
  stampLastUsedOverlay,
} from "../../open-sse/services/accountFallback.js";
import {
  BALANCED_WINDOW_SIZE,
  UNAVAILABLE_LABEL_MIN_COOLDOWN_MS,
  SUSPECT_PROBATION_MS,
} from "../../open-sse/config/errorConfig.js";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

describe("connectionHealthTier", () => {
  it("treats a never-failed account as clean", () => {
    expect(connectionHealthTier({ backoffLevel: 0, lastError: null }, NOW, SUSPECT_PROBATION_MS)).toBe(0);
    expect(connectionHealthTier({}, NOW, SUSPECT_PROBATION_MS)).toBe(0);
  });

  it("treats a recently failed account as suspect", () => {
    const recent = { backoffLevel: 2, lastError: "boom", lastErrorAt: iso(NOW - 5 * 60 * 1000) };
    expect(connectionHealthTier(recent, NOW, SUSPECT_PROBATION_MS)).toBe(1);
    const recentErrorOnly = { lastError: "boom", lastErrorAt: iso(NOW - 60 * 1000) };
    expect(connectionHealthTier(recentErrorOnly, NOW, SUSPECT_PROBATION_MS)).toBe(1);
  });

  it("returns a suspect to clean once its failure ages past probation", () => {
    const stale = { backoffLevel: 3, lastError: "boom", lastErrorAt: iso(NOW - SUSPECT_PROBATION_MS - 1000) };
    expect(connectionHealthTier(stale, NOW, SUSPECT_PROBATION_MS)).toBe(0);
  });

  it("keeps a suspect suspect when probation is disabled", () => {
    const stale = { backoffLevel: 3, lastError: "boom", lastErrorAt: iso(NOW - 24 * 3600 * 1000) };
    expect(connectionHealthTier(stale, NOW, 0)).toBe(1);
  });
});

describe("pickWindowedLru", () => {
  it("never-used accounts sort before any used timestamp", () => {
    const fleet = [
      { id: "used", priority: 1, lastUsedAt: iso(NOW - 1000) },
      { id: "never", priority: 2, lastUsedAt: null },
    ];
    // With rng returning 0, pickWindowedLru always returns the first element.
    const pick = pickWindowedLru(fleet, 1, () => 0);
    expect(pick.id).toBe("never");
  });

  it("never-used accounts break ties by priority number ascending", () => {
    const fleet = [
      { id: "low", priority: 5, lastUsedAt: null },
      { id: "high", priority: 1, lastUsedAt: null },
    ];
    const pick = pickWindowedLru(fleet, 1, () => 0);
    expect(pick.id).toBe("high");
  });

  it("used accounts sort by lastUsedAt ascending (oldest first)", () => {
    const fleet = [
      { id: "fresh", priority: 1, lastUsedAt: iso(NOW - 1000) },
      { id: "old", priority: 1, lastUsedAt: iso(NOW - 5000) },
    ];
    const pick = pickWindowedLru(fleet, 1, () => 0);
    expect(pick.id).toBe("old");
  });

  it("respects the window size ceiling", () => {
    const fleet = [
      { id: "a", priority: 1, lastUsedAt: null },
      { id: "b", priority: 2, lastUsedAt: null },
      { id: "c", priority: 3, lastUsedAt: null },
    ];
    // Window of 2 means candidate 'c' can never be picked, even with max rng.
    const pick = pickWindowedLru(fleet, 2, () => 0.999);
    expect(pick.id).toBe("b");
  });

  it("returns null on an empty fleet", () => {
    expect(pickWindowedLru([])).toBe(null);
    expect(pickWindowedLru(null)).toBe(null);
  });

  it("in-memory overlay overrides the stored timestamp immediately", () => {
    lastUsedOverlay.clear();
    const fleet = [
      { id: "a", priority: 999, lastUsedAt: iso(NOW - 3000) },
      { id: "b", priority: 999, lastUsedAt: iso(NOW - 2000) },
      { id: "c", priority: 999, lastUsedAt: iso(NOW - 1000) },
    ];
    const first = pickWindowedLru(fleet, 2, () => 0, lastUsedOverlay);
    expect(first.id).toBe("a");
    stampLastUsedOverlay(first.id, NOW);
    const second = pickWindowedLru(fleet, 2, () => 0, lastUsedOverlay);
    expect(second.id).toBe("b");
    lastUsedOverlay.clear();
  });

  it("a burst of picks with synchronous stamps never repeats a key", () => {
    lastUsedOverlay.clear();
    const fleet = [];
    for (let i = 0; i < 10; i++) {
      fleet.push({ id: `k${i}`, priority: 999, lastUsedAt: null });
    }
    const seen = new Set();
    for (let i = 0; i < 10; i++) {
      const pick = pickWindowedLru(fleet, 3, () => 0, lastUsedOverlay);
      expect(seen.has(pick.id)).toBe(false);
      seen.add(pick.id);
      stampLastUsedOverlay(pick.id, NOW + i);
    }
    expect(seen.size).toBe(10);
    lastUsedOverlay.clear();
  });
});

describe("shouldStampUnavailable", () => {
  it("does not brand an account over a short transient cooldown", () => {
    expect(shouldStampUnavailable(30 * 1000, UNAVAILABLE_LABEL_MIN_COOLDOWN_MS)).toBe(false);
    expect(shouldStampUnavailable(5 * 1000, UNAVAILABLE_LABEL_MIN_COOLDOWN_MS)).toBe(false);
  });

  it("brands an account when the cooldown is substantial", () => {
    expect(shouldStampUnavailable(UNAVAILABLE_LABEL_MIN_COOLDOWN_MS, UNAVAILABLE_LABEL_MIN_COOLDOWN_MS)).toBe(true);
    expect(shouldStampUnavailable(2 * 60 * 1000, UNAVAILABLE_LABEL_MIN_COOLDOWN_MS)).toBe(true);
  });
});

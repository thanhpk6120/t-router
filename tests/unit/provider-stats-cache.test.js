// Regression: getStatsCache() used to return the {at,data} wrapper object.
// Every caller tests the result directly (`let data = getStatsCache(); if (!data) recompute`),
// so the wrapper was always truthy and the stats map stayed null forever —
// /api/providers?summary=1 served {"stats":{"at":0,"data":null}} and the
// providers page read connected:0 for every provider ("No connections").
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getStatsCache,
  setStatsCache,
  invalidateStatsCache,
  STATS_TTL_MS,
} from "@/lib/providerStatsCache";

beforeEach(() => {
  invalidateStatsCache();
});

afterEach(() => {
  vi.useRealTimers();
  invalidateStatsCache();
});

describe("providerStatsCache", () => {
  it("returns null when empty, not the wrapper", () => {
    const got = getStatsCache();
    expect(got).toBeNull();

  });

  it("returns the stats map itself after a set", () => {
    const stats = { "openrouter|apikey": { provider: "openrouter", connected: 1, total: 1 } };
    setStatsCache(stats);
    const got = getStatsCache();
    expect(got).toBe(stats);
    // The wrapper bug made these true; they must never be again.
    expect(got).not.toHaveProperty("data");
    expect(got).not.toHaveProperty("at");
    expect(got["openrouter|apikey"].connected).toBe(1);
  });

  it("expires after STATS_TTL_MS", () => {
    vi.useFakeTimers();
    const stats = { "nvidia|apikey": { connected: 0, total: 1 } };
    setStatsCache(stats);
    expect(getStatsCache()).toBe(stats);

    vi.advanceTimersByTime(STATS_TTL_MS - 1);
    expect(getStatsCache()).toBe(stats);

    vi.advanceTimersByTime(2);
    expect(getStatsCache()).toBeNull();
  });

  it("invalidate clears immediately", () => {
    setStatsCache({ a: 1 });
    expect(getStatsCache()).not.toBeNull();
    invalidateStatsCache();
    expect(getStatsCache()).toBeNull();
  });
});

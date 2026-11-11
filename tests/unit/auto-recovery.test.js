import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RETRY_DELAYS, registerFailure, cancelRecovery, pendingRecoveries, getAvailableCandidateModels } from "../../src/sse/services/autoRecovery.js";

describe("autoRecovery service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pendingRecoveries.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defines the exact requested delay steps: 5s, 15s, 30s, 1m, 3m, 5m", () => {
    expect(RETRY_DELAYS).toEqual([5000, 15000, 30000, 60000, 180000, 300000]);
  });

  it("registers failure and schedules recovery for a connection", () => {
    registerFailure("conn-123", "model-a");
    expect(pendingRecoveries.has("conn-123")).toBe(true);
    const state = pendingRecoveries.get("conn-123");
    expect(state.index).toBe(0);
    expect(state.lastModel).toBe("model-a");
    expect(state.timer).not.toBeNull();
  });

  it("does not duplicate registration if already pending", () => {
    registerFailure("conn-123", "model-a");
    registerFailure("conn-123", "model-b");
    const state = pendingRecoveries.get("conn-123");
    expect(state.lastModel).toBe("model-a");
  });

  it("cancels recovery cleanly", () => {
    registerFailure("conn-123", "model-a");
    cancelRecovery("conn-123");
    expect(pendingRecoveries.has("conn-123")).toBe(false);
  });
});

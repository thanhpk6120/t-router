import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getProviderConnections, reorderProviderConnections, createProviderConnection } from "@/lib/db/repos/connectionsRepo.js";
import { recordProviderFailure, getProviderBreakerSnapshot } from "@/sse/services/providerBreaker.js";
import { markAccountUnavailable } from "@/sse/services/auth.js";
import { getAdapter } from "@/lib/db/driver.js";

describe("account fallback & priority reorder", () => {
  let db;

  beforeEach(async () => {
    db = await getAdapter();
    // Clean up test provider connections
    db.run("DELETE FROM providerConnections WHERE provider = 'test-fallback-prov'");
  });

  afterEach(async () => {
    if (db) {
      db.run("DELETE FROM providerConnections WHERE provider = 'test-fallback-prov'");
    }
  });

  it("reorderProviderConnections atomically updates priorities", async () => {
    const c1 = await createProviderConnection({
      provider: "test-fallback-prov",
      authType: "apikey",
      name: "Account 1",
      priority: 1,
      isActive: true,
    });
    const c2 = await createProviderConnection({
      provider: "test-fallback-prov",
      authType: "apikey",
      name: "Account 2",
      priority: 2,
      isActive: true,
    });
    const c3 = await createProviderConnection({
      provider: "test-fallback-prov",
      authType: "apikey",
      name: "Account 3",
      priority: 3,
      isActive: true,
    });

    // Reorder: Account 3 first, Account 1 second, Account 2 third
    const updatedCount = await reorderProviderConnections("test-fallback-prov", [c3.id, c1.id, c2.id]);
    expect(updatedCount).toBe(3);

    const list = await getProviderConnections({ provider: "test-fallback-prov" });
    expect(list.map((c) => c.id)).toEqual([c3.id, c1.id, c2.id]);
    expect(list.map((c) => c.priority)).toEqual([1, 2, 3]);
  });

  it("getProviderConnections sorts by priority and places null/missing priority last", async () => {
    const c1 = await createProviderConnection({
      provider: "test-fallback-prov",
      authType: "apikey",
      name: "Acc Low Priority",
      priority: 10,
      isActive: true,
    });
    const c2 = await createProviderConnection({
      provider: "test-fallback-prov",
      authType: "apikey",
      name: "Acc High Priority",
      priority: 1,
      isActive: true,
    });
    const c3 = await createProviderConnection({
      provider: "test-fallback-prov",
      authType: "apikey",
      name: "Acc Null Priority",
      priority: null,
      isActive: true,
    });

    const list = await getProviderConnections({ provider: "test-fallback-prov" });
    expect(list[0].id).toBe(c2.id); // priority 1
    expect(list[1].id).toBe(c1.id); // priority 10
    expect(list[2].id).toBe(c3.id); // priority null -> 999
  });

  it("markAccountUnavailable does not trigger provider breaker on 429 rate limit", async () => {
    const c = await createProviderConnection({
      provider: "test-fallback-prov",
      authType: "apikey",
      name: "Rate Limited Account",
      priority: 1,
      isActive: true,
    });

    // 429 error
    await markAccountUnavailable(c.id, 429, "Too Many Requests", "test-fallback-prov", "test-model");
    const snapshot = getProviderBreakerSnapshot()["test-fallback-prov"];
    expect(snapshot).toBeUndefined();
  });

  it("markAccountUnavailable triggers provider breaker failure record on 500 server error", async () => {
    const c = await createProviderConnection({
      provider: "test-fallback-prov",
      authType: "apikey",
      name: "Error Account",
      priority: 1,
      isActive: true,
    });

    // 500 error
    await markAccountUnavailable(c.id, 500, "Internal Server Error", "test-fallback-prov", "test-model");
    const snapshot = getProviderBreakerSnapshot()["test-fallback-prov"];
    expect(snapshot).toBeDefined();
    expect(snapshot.state).toBe("closed");
    expect(snapshot.failuresInWindow).toBe(1);
  });

  it("provider breaker open does not block clean accounts with no recent errors", async () => {
    const cClean = await createProviderConnection({
      provider: "test-fallback-prov",
      authType: "apikey",
      name: "Clean Account",
      priority: 2,
      isActive: true,
      lastErrorAt: null,
      backoffLevel: 0,
    });
    const cDirty = await createProviderConnection({
      provider: "test-fallback-prov",
      authType: "apikey",
      name: "Failing Account",
      priority: 1,
      isActive: true,
      lastErrorAt: new Date().toISOString(),
      backoffLevel: 2,
    });

    // Force provider breaker to trip
    for (let i = 0; i < 5; i++) {
      recordProviderFailure("test-fallback-prov", i % 2 === 0 ? "conn-a" : "conn-b");
    }

    // Now test that auth's getProviderCredentials can still pick the clean account
    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const creds = await getProviderCredentials("test-fallback-prov", new Set(), "test-model");
    expect(creds).toBeDefined();
    expect(creds.connectionId).toBe(cClean.id);
  });
});

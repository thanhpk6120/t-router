// Quota page eligibility: a MiniMax desktop-lease connection (authType
// "mcode-lease") stores no token but must still appear, because the usage
// handler borrows one from the desktop broker.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createProviderConnection, getUsageEligibleConnections } from "@/lib/db/repos/connectionsRepo.js";
import { getAdapter } from "@/lib/db/driver.js";

const PROVIDER = "test-usage-eligible";

describe("getUsageEligibleConnections", () => {
  let db;

  beforeEach(async () => {
    db = await getAdapter();
    db.run("DELETE FROM providerConnections WHERE provider = ?", [PROVIDER]);
  });

  afterEach(async () => {
    if (db) db.run("DELETE FROM providerConnections WHERE provider = ?", [PROVIDER]);
  });

  it("includes oauth, apikey-whitelisted, and lease connections; excludes plain apikey", async () => {
    await createProviderConnection({ provider: PROVIDER, authType: "oauth", name: "oauth" });
    await createProviderConnection({ provider: PROVIDER, authType: "mcode-lease", name: "lease" });
    await createProviderConnection({ provider: PROVIDER, authType: "apikey", name: "keyed" });

    const list = await getUsageEligibleConnections([PROVIDER], [PROVIDER]);

    expect(list.map((c) => c.name).sort()).toEqual(["keyed", "lease", "oauth"]);
  });

  it("includes a lease connection even with no apikey whitelist", async () => {
    await createProviderConnection({ provider: PROVIDER, authType: "mcode-lease", name: "lease" });
    await createProviderConnection({ provider: PROVIDER, authType: "apikey", name: "keyed" });

    const list = await getUsageEligibleConnections([PROVIDER], []);

    expect(list.map((c) => c.name)).toEqual(["lease"]);
  });
});

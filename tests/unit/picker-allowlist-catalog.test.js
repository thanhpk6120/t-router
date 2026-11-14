import { describe, it, expect } from "vitest";
import {
  buildModelGroups,
  resolveAllowlistByProvider,
  servedIdsFor,
  catalogFor,
  bareModelId,
} from "../../src/shared/utils/selectableModels.js";

const P = "openai-compatible-chat-aaaa-bbbb";
const conn = (id, extra = {}) => ({
  id,
  provider: P,
  isActive: true,
  providerSpecificData: {},
  ...extra,
});
const rows = (...ids) => ids.map((id) => ({ id, name: id }));

describe("picker allowlist — only the connection the provider page edits counts", () => {
  it("uses the first active connection, matching the provider page", () => {
    const first = conn("c1", { providerSpecificData: { enabledModels: ["m1", "m2"], enabledModelsExplicit: true } });
    const second = conn("c2", { providerSpecificData: { enabledModels: ["m1", "m2", "m3", "m4"], enabledModelsExplicit: true } });
    const groups = buildModelGroups({
      connections: [first, second],
      allConnections: [first, second],
      customModels: ["m1", "m2", "m3", "m4", "m5"].map((id) => ({ providerAlias: P, id, name: id, type: "llm" })),
    });
    expect((groups[P]?.models || []).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("ignores a deactivated connection's stale allowlist", () => {
    const active = conn("c1", { providerSpecificData: { enabledModels: ["m1"], enabledModelsExplicit: true } });
    const inactive = conn("c2", {
      isActive: false,
      providerSpecificData: { enabledModels: ["m1", "m2", "m3"], enabledModelsExplicit: true },
    });
    const groups = buildModelGroups({
      connections: [active],
      allConnections: [active, inactive],
      customModels: ["m1", "m2", "m3"].map((id) => ({ providerAlias: P, id, name: id, type: "llm" })),
    });
    expect((groups[P]?.models || []).map((m) => m.id)).toEqual(["m1"]);
  });

  it("treats an explicit empty allowlist as 'serves nothing'", () => {
    const c = conn("c1", { providerSpecificData: { enabledModels: [], enabledModelsExplicit: true } });
    const groups = buildModelGroups({
      connections: [c],
      allConnections: [c],
      customModels: [{ providerAlias: P, id: "m1", name: "m1", type: "llm" }],
    });
    expect(groups[P]).toBeUndefined();
  });

  it("applies no filter when the connection was never configured", () => {
    const c = conn("c1", { providerSpecificData: { enabledModels: [], enabledModelsExplicit: false } });
    const groups = buildModelGroups({
      connections: [c],
      allConnections: [c],
      customModels: ["m1", "m2"].map((id) => ({ providerAlias: P, id, name: id, type: "llm" })),
    });
    expect((groups[P]?.models || []).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("resolves a namespaced allowlist entry against the bare id", () => {
    const c = conn("c1", {
      providerSpecificData: { enabledModels: [`${P}/m2`], enabledModelsExplicit: true },
    });
    const groups = buildModelGroups({
      connections: [c],
      allConnections: [c],
      customModels: ["m1", "m2"].map((id) => ({ providerAlias: P, id, name: id, type: "llm" })),
    });
    expect((groups[P]?.models || []).map((m) => m.id)).toEqual(["m2"]);
  });

  it("returns nothing for an inactive-only provider", () => {
    const c = conn("c1", { isActive: false, providerSpecificData: { enabledModels: ["m1"], enabledModelsExplicit: true } });
    const allow = resolveAllowlistByProvider([c]);
    expect(allow.size).toBe(0);
  });
});

describe("picker catalog — read-empty is authoritative, unread is not", () => {
  it("does not fall back to the static registry when the route answered empty", () => {
    const c = conn("c1");
    const groups = buildModelGroups({
      connections: [c],
      allConnections: [c],
      liveModels: { mimo: [] },
      resolvedCatalogProviders: new Set(["mimo"]),
      providers: { mimo: { id: "mimo", alias: "mimo", name: "MiMo", color: "#000" } },
      customModels: [],
    });
    // Registry has rows for mimo, but the provider answered "nothing" — that wins.
    expect(groups.mimo).toBeUndefined();
  });

  it("uses the read catalog when the route answered with rows", () => {
    const c = conn("c1", { provider: "mimo" });
    const groups = buildModelGroups({
      connections: [c],
      allConnections: [c],
      liveModels: { mimo: rows("served-1", "served-2") },
      resolvedCatalogProviders: new Set(["mimo"]),
      providers: { mimo: { id: "mimo", alias: "mimo", name: "MiMo", color: "#000" } },
    });
    expect((groups.mimo?.models || []).map((m) => m.id)).toEqual(["served-1", "served-2"]);
  });

  it("reports unread as null and read-empty as an empty list", () => {
    expect(catalogFor({}, new Set(), "p")).toBeNull();
    expect(catalogFor({ p: [] }, new Set(["p"]), "p")).toEqual([]);
    expect(servedIdsFor({}, new Set(), "p")).toBeNull();
    expect(servedIdsFor({ p: [] }, new Set(["p"]), "p")).toEqual(new Set());
  });

  it("collapses a namespaced catalog id to its bare form in the served set", () => {
    const served = servedIdsFor({ p: rows("vendor/model") }, new Set(["p"]), "p");
    expect(served.has("vendor/model")).toBe(true);
    expect(served.has("model")).toBe(true);
  });

  it("bareModelId leaves a bare id alone and strips only the last segment", () => {
    expect(bareModelId("model")).toBe("model");
    expect(bareModelId("a/b/model")).toBe("model");
    expect(bareModelId(undefined)).toBe("");
  });

  it("never mints a compatible-node row from an allowlist entry alone", () => {
    const COMPAT = "openai-compatible-chat-compat";
    const c = {
      id: "c1",
      provider: COMPAT,
      isActive: true,
      providerSpecificData: {
        prefix: "node",
        // m-ghost is selected but the provider never served it.
        enabledModels: ["m-ghost", "m-real"],
        enabledModelsExplicit: true,
      },
    };
    const groups = buildModelGroups({
      connections: [c],
      allConnections: [c],
      liveModels: { [COMPAT]: rows("m-real") },
      resolvedCatalogProviders: new Set([COMPAT]),
    });
    expect((groups[COMPAT]?.models || []).map((m) => m.id)).toEqual(["m-real"]);
  });
});

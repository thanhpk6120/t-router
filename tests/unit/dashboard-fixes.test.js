import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Regression guards for the six dashboard/report fixes. Each case pins the
// specific mistake that caused the reported symptom, not just an identifier.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

describe("provider disable switch", () => {
  const page = read("src/app/(dashboard)/dashboard/providers/page.js");

  it("wires the switch handler through Toggle's onChange", () => {
    // The handler used to sit on a wrapping div while Toggle swallowed the
    // click with stopPropagation, so the switch did nothing for every provider.
    expect(page).toContain("onChange={(next) => onToggle(next)}");
    expect(page).not.toContain("onChange={() => {}}");
  });

  it("shows the switch for no-auth providers too", () => {
    expect(page).toContain("{(stats.total > 0 || isNoAuth) && (");
  });

  it("reads a no-auth provider's state from settings", () => {
    expect(page).toContain("providerStrategies[providerId]?.disabled === true");
  });
});

describe("bulk provider toggle", () => {
  const repo = read("src/lib/db/repos/connectionsRepo.js");
  const page = read("src/app/(dashboard)/dashboard/providers/page.js");

  it("no longer filters the UPDATE by the registry auth-type list", () => {
    // Auth types stored in the DB (access_token, mcode-lease, cookie) are not in
    // the registry list, so the filtered UPDATE matched zero rows while the route
    // still answered 200 — the provider kept serving after "disabled".
    const fn = repo.slice(repo.indexOf("export async function bulkSetConnectionsActive"));
    expect(fn).toContain("wanted.length\n    ? `UPDATE providerConnections");
    expect(fn).toContain("WHERE provider = ?`;");
  });

  it("the list switch sends no authTypes so it covers every stored value", () => {
    // Registry values (oauth/apikey) do not match stored ones (access_token,
    // mcode-lease, cookie); sending them matched zero rows.
    expect(page).toContain("authTypes: []");
    expect(page).not.toContain("JSON.stringify({ provider: providerId, authTypes, isActive: newActive })");
  });

  it("the PATCH route accepts an empty authTypes list", () => {
    const route = read("src/app/api/providers/route.js");
    expect(route).toContain("rawAuthTypes");
    expect(route).not.toContain('{ error: "provider and authTypes are required" }');
  });

  it("clears quarantine state when re-enabling", () => {
    const fn = repo.slice(repo.indexOf("export async function bulkSetConnectionsActive"));
    expect(fn).toContain("quarantineReason = NULL");
  });
});

describe("no-auth handlers honour the disable flag", () => {
  for (const handler of ["tts", "search", "imageGeneration", "videoGeneration", "fetch"]) {
    it(`${handler} checks isProviderDisabled before calling upstream`, () => {
      const src = read(`src/sse/handlers/${handler}.js`);
      expect(src).toContain("isProviderDisabled");
      // settings may be local or read inline; either is a real gate.
      expect(src).toMatch(/if \(isProviderDisabled\((settings|await getSettings\(\)), /);
    });
  }
});

describe("model picker uses the provider's live catalog", () => {
  const modal = read("src/shared/components/ModelSelectModal.js");

  it("has no hardcoded live-catalog provider list", () => {
    expect(modal).not.toMatch(/LIVE_CATALOG_PROVIDERS/);
  });

  it("reads the live catalog per provider", () => {
    expect(modal).toMatch(/const liveModels = liveCatalogs\[providerId\] \|\| \[\]/);
  });

  it("keys its fetch effect on a stable signature, not the array prop", () => {
    // Depending on the array identity re-ran the fetch on every parent render.
    expect(modal).toMatch(/\}, \[isOpen, signature, firstConnectionByProvider\]\);/);
  });
});

describe("active-model allowlist", () => {
  const v1 = read("src/app/api/v1/models/route.js");
  const detail = read("src/app/(dashboard)/dashboard/providers/[id]/page.js");

  it("filters published models by enabledModels after the live override", () => {
    const override = v1.indexOf("const live = explicitlyEmptySelection ? null : liveByProvider.get(providerId);");
    const filter = v1.indexOf("if (hasExplicitEnabledModels) {", override);
    expect(override).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(override);
  });

  it("lists every loaded model with a switch instead of hiding deselected ones", () => {
    expect(detail).toContain("const loadedDisplayModels = allModels");
    expect(detail).toContain("enabled={m.enabled}");
  });

  it("writes the selection to the connection allowlist", () => {
    expect(detail).toContain("enabledModels: nextIds");
    expect(detail).toContain("persistModelSelection");
  });

  it("marks the selection explicit so an emptied list stays authoritative", () => {
    // Without the flag, [] is indistinguishable from "never chosen" and the
    // whole catalog is republished while every switch reads off.
    expect(detail).toContain("enabledModelsExplicit: true");
    // The page reads the flag through local state so an optimistic save shows
    // up in the same render; the connection payload is still the source.
    expect(detail).toContain("enabledModelsExplicit === true");
    expect(v1).toContain("providerSpecificData?.enabledModelsExplicit === true");
  });
});

describe("capability probes", () => {
  const ping = read("src/app/api/models/test/ping.js");
  const route = read("src/app/api/models/test/route.js");

  it("accepts an image and a thinking probe", () => {
    expect(route).toContain("probe");
    expect(ping).toContain('probe === "image"');
    expect(ping).toContain('probe === "thinking"');
  });

  it("rejects a 200 that silently dropped the image", () => {
    expect(ping).toMatch(/\\\[image omitted/);
  });

  it("accepts colour synonyms instead of requiring the literal word red", () => {
    expect(ping).toContain("COLOUR_PATTERN");
    expect(ping).toContain("crimson");
  });

  it("requires real reasoning output for the thinking probe", () => {
    expect(ping).toContain("reasoning_tokens");
    expect(ping).toContain("No reasoning output");
  });
});

describe("prompt rule multi-model picker", () => {
  const src = read("src/app/(dashboard)/dashboard/prompt-injection/PromptInjectionClient.js");

  it("keeps the picker open and supports deselect", () => {
    expect(src).toContain("closeOnSelect={false}");
    expect(src).toContain("onDeselect={(m) => handleRemoveModel(modelPickValue(m))}");
    expect(src).toContain("addedModelValues={selectedModels}");
  });
});

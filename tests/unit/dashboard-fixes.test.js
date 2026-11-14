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
    // Those counters live in the `data` JSON blob. An UPDATE naming them threw
    // "no such column", so re-enabling a provider answered 500 — the provider
    // could be switched off but never back on.
    const fn = repo.slice(repo.indexOf("export async function bulkSetConnectionsActive"));
    expect(fn).toContain("delete conn.quarantineReason");
    expect(fn).not.toContain("quarantineReason = NULL");
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
    // Both catalog branches go through one resolver, so "not read" and "read and
    // empty" stay distinguishable (see selectableModels.catalogFor).
    expect(modal).toMatch(/const liveModels = catalogForProvider\(providerId\);/);
    expect(modal).toContain("catalogForProvider");
  });

  it("keys its fetch effect on a stable signature, not the array prop", () => {
    // Depending on the array identity re-ran the fetch on every parent render.
    expect(modal).toMatch(/\}, \[isOpen, signature\]\);/);
    // ...and the signature is the derived string, not `activeProviders`.
    expect(modal).not.toMatch(/\}, \[isOpen, activeProviders\]\);/);
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
    // One list per provider: custom rows + loaded catalog, rendered together
    // under the toolbar (no second block above the search box).
    expect(detail).toContain("const displayModels = [");
    expect(detail).toContain("{displayModels.map((m) => (");
    // X on a row still switches the model off (restorable from "Disabled models").
    expect(detail).toContain("onDeleteAlias={() => handleDisableModel(m.id)}");
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
  const chat = read("src/sse/handlers/chat.js");
  const chatCore = read("open-sse/handlers/chatCore.js");
  const modal = read("src/shared/components/ModelSelectModal.js");

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

  it("measures one model: the probe bypasses the capacity adapter and modality strip", () => {
    // Both filters belong to normal traffic. Without this the dashboard reported
    // the pool model's vision (green "image OK") for a model that never saw the
    // image, and the strip answered from the capability table instead.
    expect(ping).toContain("x-9r-capability-probe");
    expect(chat).toContain('clientRawRequest?.headers?.["x-9r-capability-probe"] === "1"');
    expect(chat).toContain("if (soloAugmented.length > 1 && !isCapabilityProbe)");
    expect(chatCore).toContain('clientRawRequest?.headers?.["x-9r-capability-probe"]');
    expect(chatCore).toContain("if (!passthrough && !isCapabilityProbe)");
  });

  it("reads thinking from the stream, where the router keeps reasoning", () => {
    // The non-stream handler deletes message.reasoning_content when the answer
    // also has content, so a reasoning model read as "no thinking" unless its
    // provider reported reasoning_tokens.
    expect(ping).toContain("runThinkingProbeStream");
    expect(ping).toContain("stream: true");
    expect(ping).toContain("delta.reasoning_content");
  });

  it("offers both probes for every model", () => {
    const row = read("src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js");
    expect(row).not.toContain("caps?.vision && !caps?.imageOutput");
    expect(row).not.toContain("onTestThinking && caps?.reasoning");
  });

  it("offers only the models the provider publishes in its picker", () => {
    expect(modal).toContain("allowByProvider");
    expect(modal).toContain("allow.ids.has(m.id)");
    expect(modal).not.toContain("deliberately NOT applied");
  });
});

describe("enabling a provider", () => {
  const repo = read("src/lib/db/repos/connectionsRepo.js");

  it("does not UPDATE quarantine counters as if they were columns", () => {
    // They live inside the `data` JSON blob. Naming them in an UPDATE threw
    // "no such column", rolled the transaction back and answered 500, so a
    // provider could be disabled but never enabled again.
    expect(repo).not.toMatch(/SET consecutiveAuthFailures = 0/);
    expect(repo).toContain("delete conn.consecutiveAuthFailures");
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

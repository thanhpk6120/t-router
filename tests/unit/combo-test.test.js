// Combo tester: the API reports each member's health + which one serves next,
// and peeking at the rotation must never change what the next real request does.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getRotatedModels, peekRotatedModels, resetComboRotation } from "../../open-sse/services/combo.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const read = (relPath) => readFileSync(join(repoRoot, relPath), "utf8");

const MODELS = ["alpha/one", "beta/two", "gamma/three"];

describe("peekRotatedModels", () => {
  it("shows the next request's order without consuming a rotation slot", () => {
    const name = "unit-peek-combo";
    resetComboRotation(name);

    // Two peeks in a row must return the same head: a peek is not a request.
    expect(peekRotatedModels(MODELS, name, "round-robin")).toEqual(MODELS);
    expect(peekRotatedModels(MODELS, name, "round-robin")).toEqual(MODELS);

    // A real dispatch advances the rotation; the peek now reports the next head.
    getRotatedModels(MODELS, name, "round-robin", 1);
    expect(peekRotatedModels(MODELS, name, "round-robin")).toEqual(["beta/two", "gamma/three", "alpha/one"]);

    resetComboRotation(name);
  });

  it("keeps the configured order for non-rotating strategies", () => {
    expect(peekRotatedModels(MODELS, "x", "fallback")).toEqual(MODELS);
    expect(peekRotatedModels(MODELS, "x", "capacity")).toEqual(MODELS);
  });

  it("is defensive about the input", () => {
    expect(peekRotatedModels(null, "x", "round-robin")).toEqual([]);
    expect(peekRotatedModels([], "x", "round-robin")).toEqual([]);
  });
});

describe("POST /api/combos/test", () => {
  const route = read("src/app/api/combos/test/route.js");

  it("validates the combo and probes each member on its own", () => {
    expect(route).toContain("comboName is required");
    expect(route).toContain("Combo has no models");
    expect(route).toContain("pingModelByKind(model, PROBE_KIND, baseUrl)");
    // The member is the tested model — never the combo name, which would let
    // the router answer with a different member.
    expect(route).not.toContain("pingModelByKind(comboName");
  });

  it("reports strategy, rotation-aware order and the predicted member", () => {
    expect(route).toContain("filterActiveComboModels(models)");
    expect(route).toContain("peekRotatedModels(activeModels, comboName, strategy)");
    expect(route).toContain("healthy[0]?.model");
    // Fusion is answered by the judge, not by the first healthy panel member.
    expect(route).toContain('strategy === "fusion" ? judgeModel : (healthy[0]?.model || null)');
  });

  it("marks nested combos so the dialog can label them", () => {
    expect(route).toContain("isCombo: comboSet.has(model)");
  });
});

describe("combos page surfaces the test", () => {
  const page = read("src/app/(dashboard)/dashboard/combos/page.js");

  it("has a Test action and a results dialog", () => {
    expect(page).toContain("handleTestCombo");
    expect(page).toContain('fetch("/api/combos/test"');
    expect(page).toContain("function ComboTestModal");
    expect(page).toContain("<ComboTestModal result={comboTest}");
    expect(page).toContain("onTest={() => handleTestCombo(combo)}");
  });

  it("shows why a combo routes the way it does", () => {
    expect(page).toContain("COMBO_STRATEGY_SUMMARY");
    expect(page).toContain("No member is serving");
  });
});

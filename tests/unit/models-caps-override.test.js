// GET /api/models: a custom-model row carrying explicit caps for a model
// already present in the built-in catalog is a caps OVERRIDE, not a shadow.
// It must merge onto the built-in entry instead of being dropped, otherwise a
// hand-set capability can never take effect on a preloaded model and the
// model stays out of the combo Vision picker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let modelsRoute;
let builtInFullModel;
let builtInProviderAlias;
let builtInModelId;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-caps-override-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  modelsRoute = await import("@/app/api/models/route.js");

  // Pick one real built-in model so the override lands on a catalog entry
  // rather than inventing a fake provider.
  const { AI_MODELS } = await import("@/shared/constants/models.js");
  const { getProviderAlias } = await import("@/shared/constants/providers.js");
  const sample = AI_MODELS.find((m) => m.provider && m.model);
  if (!sample) throw new Error("no built-in model in catalog");
  builtInModelId = sample.model;
  builtInProviderAlias = getProviderAlias(sample.provider) || sample.provider;
  builtInFullModel = `${builtInProviderAlias}/${builtInModelId}`;
});

afterAll(() => {
  // Best-effort: the SQLite handle stays open, Windows refuses deletion.
  if (tempDir) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* locked on Windows */ }
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function readModels() {
  modelsRoute.__resetModelsCache();
  const res = await modelsRoute.GET();
  const data = await res.json();
  return data.models;
}

function findEntry(models, fullModel) {
  return models.find((m) => m.routedModel === fullModel || m.fullModel === fullModel);
}

describe("/api/models — caps override on a built-in model", () => {
  it("baseline: the built-in model is listed exactly once", async () => {
    const models = await readModels();
    const matches = models.filter(
      (m) => m.routedModel === builtInFullModel || m.fullModel === builtInFullModel,
    );
    expect(matches.length).toBe(1);
  });

  it("an explicit caps row overrides the built-in entry instead of being dropped", async () => {
    const baseline = findEntry(await readModels(), builtInFullModel);
    const baselineVision = baseline?.caps?.vision;

    await db.addCustomModel({
      providerAlias: builtInProviderAlias,
      id: builtInModelId,
      type: "llm",
      caps: { vision: !baselineVision },
    });

    const models = await readModels();
    const matches = models.filter(
      (m) => m.routedModel === builtInFullModel || m.fullModel === builtInFullModel,
    );
    // Still one entry: the override merges, it does not append a duplicate.
    expect(matches.length).toBe(1);
    expect(matches[0].caps.vision).toBe(!baselineVision);
  });

  it("re-editing the same override keeps exactly one entry with the new value", async () => {
    await db.addCustomModel({
      providerAlias: builtInProviderAlias,
      id: builtInModelId,
      type: "llm",
      caps: { vision: true },
    });
    await db.addCustomModel({
      providerAlias: builtInProviderAlias,
      id: builtInModelId,
      type: "llm",
      caps: { vision: false },
    });

    const models = await readModels();
    const matches = models.filter(
      (m) => m.routedModel === builtInFullModel || m.fullModel === builtInFullModel,
    );
    expect(matches.length).toBe(1);
    expect(matches[0].caps.vision).toBe(false);
  });

  it("an override preserves the built-in caps it did not touch", async () => {
    const baseline = findEntry(await readModels(), builtInFullModel);
    const baselineContext = baseline.caps.contextWindow;

    await db.addCustomModel({
      providerAlias: builtInProviderAlias,
      id: builtInModelId,
      type: "llm",
      caps: { vision: true },
    });

    const after = findEntry(await readModels(), builtInFullModel);
    expect(after.caps.contextWindow).toBe(baselineContext);
  });

  it("a custom row WITHOUT caps still appends a new model for an unknown id", async () => {
    await db.addCustomModel({
      providerAlias: builtInProviderAlias,
      id: "test-shadowless-new-model",
      type: "llm",
      name: "New Model",
    });
    const models = await readModels();
    const entry = models.find(
      (m) => m.fullModel === `${builtInProviderAlias}/test-shadowless-new-model`,
    );
    expect(entry).toBeTruthy();
    expect(entry.name).toBe("New Model");
  });
});

describe("/api/models — caps cache invalidation", () => {
  it("a second override save is visible without waiting for the TTL", async () => {
    await db.addCustomModel({
      providerAlias: builtInProviderAlias,
      id: builtInModelId,
      type: "llm",
      caps: { vision: true },
    });
    expect(findEntry(await readModels(), builtInFullModel).caps.vision).toBe(true);

    // No __resetModelsCache() here on purpose: addCustomModel must invalidate.
    await db.addCustomModel({
      providerAlias: builtInProviderAlias,
      id: builtInModelId,
      type: "llm",
      caps: { vision: false },
    });
    const res = await modelsRoute.GET();
    const data = await res.json();
    const entry = findEntry(data.models, builtInFullModel);
    expect(entry.caps.vision).toBe(false);
  });
});
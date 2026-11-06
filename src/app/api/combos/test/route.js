import { NextResponse } from "next/server";
import { getApiKeys, getComboByName, getCombos, getSettings } from "@/lib/localDb";
import { resolveComboStrategy } from "@/sse/services/pairStrategy.js";
import { filterActiveComboModels } from "@/sse/services/model.js";
import { peekRotatedModels } from "open-sse/services/combo.js";
import { pingModelByKind } from "@/app/api/models/test/ping.js";
import { UPDATER_CONFIG } from "@/shared/constants/config";

export const dynamic = "force-dynamic";
// One real model call per member, in parallel; a reasoning model can take 30s.
export const maxDuration = 120;

const PROBE_KIND = "chat";

function internalBaseUrl() {
  return `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
}

/**
 * POST /api/combos/test — { comboName }
 *
 * Answers the three questions an operator has about a combo:
 *   1. how it routes right now (`strategy`, rotation-aware `order`),
 *   2. whether every member actually serves (`results[]`, one real call each),
 *   3. which member the next request will use (`predictedModel`).
 *
 * Each member is probed on its own (model = member, never the combo name), so
 * the verdict describes that model. The probe carries the capability-probe
 * header used by the provider page's model tests, which keeps the router from
 * answering through the capacity adapter.
 *
 * The combo's own rotation state is only READ (peekRotatedModels): running the
 * real dispatcher would consume a round-robin slot and change what the next
 * production request does.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const comboName = String(body?.comboName || "").trim();
    if (!comboName) {
      return NextResponse.json({ error: "comboName is required" }, { status: 400 });
    }

    const combo = await getComboByName(comboName);
    if (!combo) {
      return NextResponse.json({ error: `Combo "${comboName}" not found` }, { status: 404 });
    }

    const models = [...new Set(
      (combo.models || [])
        .map((m) => (typeof m === "string" ? m : m?.model))
        .filter((m) => typeof m === "string" && m.trim()),
    )];
    if (models.length === 0) {
      return NextResponse.json({ error: "Combo has no models" }, { status: 400 });
    }

    const settings = await getSettings().catch(() => ({}));

    // The probes go through the same /v1 pipeline as a real client, so they
    // need a key when the gateway requires one. Say so instead of showing every
    // member as "HTTP 401: Missing API key", which reads like the models are
    // broken.
    if (settings?.requireApiKey) {
      const keys = await getApiKeys().catch(() => []);
      const hasActiveKey = keys.some((key) => key?.isActive !== false && key?.key);
      if (!hasActiveKey) {
        return NextResponse.json(
          { error: "No API key configured — create one under Endpoint & Key so the combo test can call the router." },
          { status: 400 },
        );
      }
    }

    const activeModels = await filterActiveComboModels(models);
    const strategy = await resolveComboStrategy(comboName, activeModels.length > 0 ? activeModels : models, settings, null)
      .catch(() => "fallback");
    const order = peekRotatedModels(activeModels, comboName, strategy);
    const activeSet = new Set(activeModels);
    const baseUrl = internalBaseUrl();

    const allCombos = await getCombos().catch(() => []);
    const comboSet = new Set(allCombos.map((c) => c.name));

    // Active models first in their rotated order, then disabled models
    const disabledModels = models.filter((m) => !activeSet.has(m));
    const fullOrder = [...order, ...disabledModels];

    const results = await Promise.all(fullOrder.map(async (model, index) => {
      const isDisabled = !activeSet.has(model);
      if (isDisabled) {
        return {
          model,
          order: "-",
          isCombo: comboSet.has(model),
          disabled: true,
          status: "disabled",
          latencyMs: 0,
          error: null,
          note: "Model is disabled (skipped in combo)",
        };
      }
      const startedAt = Date.now();
      const ping = await pingModelByKind(model, PROBE_KIND, baseUrl)
        .catch((error) => ({ ok: false, error: error?.message || "Probe failed" }));
      return {
        model,
        order: index + 1,
        isCombo: comboSet.has(model),
        disabled: false,
        status: ping?.ok ? "ok" : "error",
        latencyMs: ping?.latencyMs ?? (Date.now() - startedAt),
        error: ping?.ok ? null : String(ping?.error || "Unknown error").slice(0, 400),
        note: ping?.note || null,
      };
    }));

    const healthy = results.filter((result) => result.status === "ok");
    const judgeModel = settings?.comboStrategies?.[comboName]?.judgeModel || models[0] || null;

    return NextResponse.json({
      comboName,
      strategy,
      models,
      order,
      // Fusion runs the whole panel, so the member that produces the answer is
      // the judge, not the first healthy model. Every other strategy starts at
      // the head of `order` and falls through on failure.
      predictedModel: strategy === "fusion" ? judgeModel : (healthy[0]?.model || null),
      judgeModel: strategy === "fusion" ? judgeModel : null,
      healthyCount: healthy.length,
      total: models.length,
      results,
      testedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.log("Error testing combo:", error);
    return NextResponse.json({ error: "Failed to test combo" }, { status: 500 });
  }
}

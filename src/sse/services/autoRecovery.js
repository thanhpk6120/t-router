import { getProviderConnectionById, updateProviderConnection, getLoadedModels } from "@/lib/localDb";
import { checkAndRefreshToken } from "./tokenRefresh.js";
import { clearAccountError } from "./auth.js";
import { isModelDisabled } from "./model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import * as log from "../utils/logger.js";

export const RETRY_DELAYS = [5000, 15000, 30000, 60000, 180000, 300000];
export const pendingRecoveries = new Map();

/**
 * Register an account failure on 502 or 503.
 * @param {string} connectionId
 * @param {string|null} failedModel
 */
export function registerFailure(connectionId, failedModel = null) {
  if (!connectionId || connectionId === "noauth") return;
  if (pendingRecoveries.has(connectionId)) return;

  const state = {
    index: 0,
    lastModel: failedModel,
    timer: null,
  };
  pendingRecoveries.set(connectionId, state);
  scheduleRetry(connectionId, state);
}

export function cancelRecovery(connectionId) {
  const state = pendingRecoveries.get(connectionId);
  if (state?.timer) {
    clearTimeout(state.timer);
  }
  pendingRecoveries.delete(connectionId);
}

function scheduleRetry(connectionId, state) {
  if (state.index >= RETRY_DELAYS.length) {
    pendingRecoveries.delete(connectionId);
    log.info("AUTO_RECOVERY", `Recovery retries exhausted for ${connectionId}`);
    return;
  }

  const delay = RETRY_DELAYS[state.index];
  log.info("AUTO_RECOVERY", `Scheduled recovery retry #${state.index + 1} for ${connectionId} in ${delay / 1000}s`);

  state.timer = setTimeout(() => {
    executeRecoveryTest(connectionId).catch((err) => {
      log.warn("AUTO_RECOVERY", `Error during recovery test for ${connectionId}: ${err?.message || err}`);
    });
  }, delay);
}

export async function getAvailableCandidateModels(conn) {
  const provider = conn.provider;
  let rawList = [];

  const enabled = conn.providerSpecificData?.enabledModels;
  if (Array.isArray(enabled) && enabled.length > 0) {
    rawList = enabled.filter((m) => typeof m === "string" && m.trim());
  }

  if (rawList.length === 0) {
    try {
      const loaded = (await getLoadedModels(conn.id)) || (await getLoadedModels(provider));
      if (loaded?.models && Array.isArray(loaded.models) && loaded.models.length > 0) {
        rawList = loaded.models.map((m) => m.id || m.name || m).filter(Boolean);
      }
    } catch {}
  }

  if (rawList.length === 0) {
    const reg = PROVIDER_MODELS[provider];
    if (Array.isArray(reg) && reg.length > 0) {
      rawList = reg.map((m) => m.id || m).filter(Boolean);
    }
  }

  if (rawList.length === 0 && conn.defaultModel) {
    rawList = [conn.defaultModel];
  }

  const activeCandidates = [];
  for (const m of rawList) {
    const fullId = m.includes("/") ? m : `${provider}/${m}`;
    const disabled = await isModelDisabled(fullId).catch(() => false);
    if (!disabled) {
      activeCandidates.push(m);
    }
  }

  return activeCandidates;
}

export async function executeRecoveryTest(connectionId) {
  const state = pendingRecoveries.get(connectionId);
  if (!state) return;

  const conn = await getProviderConnectionById(connectionId).catch(() => null);
  if (!conn) {
    pendingRecoveries.delete(connectionId);
    return;
  }

  const candidates = await getAvailableCandidateModels(conn);
  if (candidates.length === 0) {
    log.warn("AUTO_RECOVERY", `No active candidate models found for connection ${connectionId}`);
    state.index++;
    scheduleRetry(connectionId, state);
    return;
  }

  const differentCandidates = candidates.filter((m) => m !== state.lastModel);
  const modelToTest = differentCandidates.length > 0
    ? differentCandidates[Math.floor(Math.random() * differentCandidates.length)]
    : candidates[0];

  state.lastModel = modelToTest;
  log.info("AUTO_RECOVERY", `Testing account ${connectionId} (${conn.name || conn.email || conn.provider}) with model ${modelToTest} (attempt #${state.index + 1})`);

  let testPassed = false;
  try {
    const refreshed = await checkAndRefreshToken(conn.provider, conn).catch(() => conn);

    const result = await handleChatCore({
      body: {
        model: `${conn.provider}/${modelToTest}`,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      },
      modelInfo: { provider: conn.provider, model: modelToTest },
      credentials: refreshed,
      connectionId: conn.id,
      log,
    });

    if (result && result.success) {
      testPassed = true;
    } else {
      const status = result?.status || 500;
      log.warn("AUTO_RECOVERY", `Test returned status ${status} for ${connectionId}`);
    }
  } catch (err) {
    log.warn("AUTO_RECOVERY", `Chat probe threw for ${connectionId}: ${err?.message || err}`);
  }

  if (testPassed) {
    log.info("AUTO_RECOVERY", `✅ Account ${connectionId} (${conn.name || conn.email || conn.provider}) passed test! Reactivating...`);
    await clearAccountError(connectionId, conn, modelToTest).catch(() => {});
    await updateProviderConnection(connectionId, {
      isActive: true,
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0,
    }).catch(() => {});
    pendingRecoveries.delete(connectionId);
  } else {
    state.index++;
    scheduleRetry(connectionId, state);
  }
}

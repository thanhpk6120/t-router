/**
 * R1/R4 Combo Advisor: dedupe, free stack + holding, tiered draft, dry-run.
 */

export function isChatModelId(id) {
  if (!id || typeof id !== "string" || !id.includes("/")) return false;
  const lower = id.toLowerCase();
  if (lower.includes("-image") || lower.includes("flux") || lower.includes("tts") || lower.includes("stt") || lower.includes("embed")) {
    return false;
  }
  return true;
}

export function dedupeCandidates(candidates = []) {
  const map = new Map();
  for (const c of candidates) {
    const modelName = c.id.includes("/") ? c.id.slice(c.id.indexOf("/") + 1) : c.id;
    const existing = map.get(modelName);
    if (!existing) {
      map.set(modelName, c);
      continue;
    }
    // Prefer healthy, then lower latency
    if (!existing.healthy && c.healthy) {
      map.set(modelName, c);
    } else if (existing.healthy === c.healthy && (c.latencyMs ?? 9999) < (existing.latencyMs ?? 9999)) {
      map.set(modelName, c);
    }
  }
  return Array.from(map.values());
}

export function buildFreeStack(candidates = []) {
  const freeModels = candidates.filter((c) => c.free);
  const members = [];
  const holding = [];

  for (const c of freeModels) {
    if (c.rateLimited || !c.healthy) {
      holding.push(c.id);
    } else {
      members.push(c);
    }
  }

  members.sort((a, b) => (a.latencyMs ?? 100) - (b.latencyMs ?? 100));

  return {
    members: members.map((m) => m.id),
    holding,
  };
}

export function buildTieredDraft(candidates = []) {
  const pool = [...candidates];
  const members = [];
  const tiers = {};

  // 1. Quality tier: tools & reasoning & large context
  const qualityCandidate = pool
    .slice()
    .sort((a, b) => {
      const aScore = (a.reasoning ? 2 : 0) + (a.tools ? 1 : 0) + (a.contextWindow || 0) / 10000;
      const bScore = (b.reasoning ? 2 : 0) + (b.tools ? 1 : 0) + (b.contextWindow || 0) / 10000;
      return bScore - aScore;
    })[0];

  if (qualityCandidate) {
    tiers.quality = qualityCandidate.id;
    members.push(qualityCandidate.id);
  }

  // 2. Fast tier: lowest latency not already in members
  const fastCandidate = pool
    .filter((c) => !members.includes(c.id))
    .sort((a, b) => (a.latencyMs ?? 999) - (b.latencyMs ?? 999))[0];

  if (fastCandidate) {
    tiers.fast = fastCandidate.id;
    members.push(fastCandidate.id);
  }

  // 3. Cheap tier: free or lowest cost not already in members
  const cheapCandidate = pool
    .filter((c) => !members.includes(c.id))
    .sort((a, b) => (b.free ? 1 : 0) - (a.free ? 1 : 0))[0];

  if (cheapCandidate) {
    tiers.cheap = cheapCandidate.id;
    members.push(cheapCandidate.id);
  }

  return { members, tiers };
}

export function dryRunPreview({ draft, existingCombos = [], proposedName }) {
  const exists = existingCombos.some((c) => c.name === proposedName);
  return {
    wouldCreate: !exists,
    proposedName,
    memberCount: draft?.members?.length || 0,
  };
}

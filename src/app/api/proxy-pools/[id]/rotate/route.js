import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { rotateProxyWithRangeCheck } from "open-sse/utils/proxyRotator.js";

// POST /api/proxy-pools/[id]/rotate - Trigger IP rotation via rotateLink (opencode2api mechanism with range cache)
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getProxyPoolById(id);
    if (!pool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const rotateLink = pool.rotateLink || pool.rotateUrl;
    if (!rotateLink) {
      return NextResponse.json({ error: "No rotateLink configured for this proxy pool" }, { status: 400 });
    }

    const result = await rotateProxyWithRangeCheck(rotateLink, pool.proxyUrl, {
      minIntervalSeconds: pool.minIntervalSeconds,
      failedIpCacheSize: pool.failedIpCacheSize,
    });
    const now = new Date().toISOString();
    if (result.ok) {
      await updateProxyPool(id, {
        lastRotatedAt: now,
        lastRotateResponse: `Rotated successfully (${result.attempts || 1} attempts)${result.exitRange ? ` -> ${result.exitRange}` : ""}`,
        lastExitRange: result.exitRange || undefined,
      });
    }

    return NextResponse.json({
      ok: result.ok,
      exitRange: result.exitRange || null,
      attempts: result.attempts || 1,
      timestamp: now,
      error: result.error || null,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
  }
}

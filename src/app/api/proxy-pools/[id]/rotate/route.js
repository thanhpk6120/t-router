import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { evictProxyDispatcher } from "open-sse/utils/proxyFetch.js";

// POST /api/proxy-pools/[id]/rotate - Trigger IP rotation via rotateLink (opencode2api mechanism)
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

    const response = await fetch(rotateLink, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });

    const text = await response.text();
    const now = new Date().toISOString();
    if (response.ok) {
      if (pool.proxyUrl) {
        evictProxyDispatcher(pool.proxyUrl);
      }
      await updateProxyPool(id, {
        lastRotatedAt: now,
        lastRotateResponse: text.slice(0, 500),
      });
    }
    return NextResponse.json({
      ok: response.ok,
      status: response.status,
      response: text.slice(0, 500),
      timestamp: now,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
  }
}

import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getLatencyStats } from "@/lib/latencyStats.js";

export const dynamic = "force-dynamic";

const PERIOD_MS = {
  "24h": 24 * 3600 * 1000,
  "7d": 7 * 24 * 3600 * 1000,
  "30d": 30 * 24 * 3600 * 1000,
};

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const ms = PERIOD_MS[period];
    const since = ms ? new Date(Date.now() - ms).toISOString() : null;
    const db = await getAdapter();
    const stats = await getLatencyStats(db, since);
    return NextResponse.json(stats, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

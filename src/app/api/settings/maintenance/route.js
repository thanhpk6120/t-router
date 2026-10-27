import { NextResponse } from "next/server";
import { runMaintenanceNow } from "@/lib/db/maintenance.js";
import { getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    const cfg = settings.dbMaintenance || {};
    return NextResponse.json(cfg, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

export async function POST() {
  try {
    const result = await runMaintenanceNow();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

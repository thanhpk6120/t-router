import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/localDb";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    const { comboIds } = body || {};
    if (!Array.isArray(comboIds)) {
      return NextResponse.json({ error: "comboIds must be an array" }, { status: 400 });
    }

    const cleanIds = [];
    const seen = new Set();
    for (const id of comboIds) {
      if (typeof id !== "string") continue;
      const trimmed = id.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      cleanIds.push(trimmed);
    }

    await updateSettings({ comboOrder: cleanIds });
    return NextResponse.json({ success: true, count: cleanIds.length });
  } catch (error) {
    console.error("Error reordering combos:", error);
    return NextResponse.json({ error: "Failed to reorder combos" }, { status: 500 });
  }
}

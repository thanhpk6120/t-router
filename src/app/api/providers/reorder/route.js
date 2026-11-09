import { NextResponse } from "next/server";
import { reorderProviderConnections } from "@/models";

export async function POST(request) {
  try {
    const { provider, connectionIds } = await request.json();
    if (!provider || !Array.isArray(connectionIds)) {
      return NextResponse.json({ error: "provider and connectionIds are required" }, { status: 400 });
    }
    const count = await reorderProviderConnections(provider, connectionIds);
    return NextResponse.json({ success: true, count });
  } catch (error) {
    console.error("Error reordering connections:", error);
    return NextResponse.json({ error: "Failed to reorder connections" }, { status: 500 });
  }
}

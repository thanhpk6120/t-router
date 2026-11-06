import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { fetchCompatibleProviderModels } from "@/lib/compatibleModels";

/**
 * GET /api/providers/[id]/compatible-models
 * Helper endpoint returning live model listings for OpenAI/Anthropic compatible providers.
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    const result = await fetchCompatibleProviderModels(connection);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, errorText: result.errorText },
        { status: result.status }
      );
    }
    return NextResponse.json({ models: result.models });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { pingModelByKind } from "./ping";
import { checkDashboardThrottle, DASHBOARD_THROTTLE_MAX_TEST } from "@/lib/auth/dashboardThrottle";

// POST /api/models/test - Ping a single model via internal completions or embeddings
export async function POST(request) {
  const throttle = checkDashboardThrottle(request, "models/test", DASHBOARD_THROTTLE_MAX_TEST);
  if (!throttle.allowed) {
    return NextResponse.json(
      { ok: false, stage: "rate_limited", error: "Too many model tests. Please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(throttle.retryAfterSec) } }
    );
  }
  try {
    const { model, kind, probe } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const result = await pingModelByKind(model, kind || "llm", undefined, probe || "text");
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

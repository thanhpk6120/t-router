import { NextResponse } from "next/server";
import { getNotifyStatus, getNotifyConfig, saveNotifyConfig } from "@/lib/notify.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getNotifyStatus();
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

// Partial update: blank secret/token keeps the current stored value.
export async function POST(request) {
  try {
    const body = await request.json();
    const current = await getNotifyConfig();
    const next = {
      telegram: {
        enabled: body.telegram?.enabled ?? current.telegram.enabled,
        botToken: body.telegram?.botToken ? String(body.telegram.botToken).trim() : current.telegram.botToken,
        chatId: body.telegram?.chatId !== undefined ? String(body.telegram.chatId).trim() : current.telegram.chatId,
      },
      webhook: {
        enabled: body.webhook?.enabled ?? current.webhook.enabled,
        url: body.webhook?.url !== undefined ? String(body.webhook.url).trim() : current.webhook.url,
        secret: body.webhook?.secret ? String(body.webhook.secret) : current.webhook.secret,
      },
    };
    await saveNotifyConfig(next);
    return NextResponse.json(await getNotifyStatus());
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

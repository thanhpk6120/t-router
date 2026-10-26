import { NextResponse } from "next/server";
import { killAppProcesses, spawnUpdaterAndExit } from "@/lib/appUpdater";

export async function POST() {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json(
      { success: false, message: "Update is only available in production build (t-router CLI)" },
      { status: 403 }
    );
  }

  try {
    // Kill sibling processes (cloudflared, MITM, stray next-server) to release file locks on Windows
    await killAppProcesses();
  } catch { /* best effort */ }

  // Schedule detached updater then exit current server process
  spawnUpdaterAndExit();

  return NextResponse.json({ success: true, message: "Updater started. This app will exit shortly." });
}

export async function GET() {
  try {
    const { DATA_DIR } = await import("@/lib/dataDir");
    const path = await import("path");
    const fs = await import("fs");
    const statusFile = path.join(DATA_DIR, "update", "status.json");
    if (fs.existsSync(statusFile)) {
      const content = fs.readFileSync(statusFile, "utf8");
      return NextResponse.json(JSON.parse(content));
    }
  } catch {}
  return NextResponse.json({ status: "idle" });
}

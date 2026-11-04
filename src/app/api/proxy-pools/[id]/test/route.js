import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { testProxyUrl, testRelayUrl, probeExitIp } from "@/lib/network/proxyTest";

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const isRelay = proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify";
    const result = isRelay
      ? await testRelayUrl(proxyPool.proxyUrl)
      : await testProxyUrl({ proxyUrl: proxyPool.proxyUrl });
    const now = new Date().toISOString();

    // A passing health check only proves "something answered". The exit IP is
    // what proves THIS proxy carried the request — and tells the operator which
    // address the provider will see.
    let exitIp = null;
    let exitIpError = null;
    if (result.ok && !isRelay) {
      const probe = await probeExitIp({ proxyUrl: proxyPool.proxyUrl });
      if (probe.ok) exitIp = probe.ip;
      else exitIpError = probe.error || "Exit-IP check failed";
    }

    // opt46 (M2-proxy): a health test only records testStatus/lastTestedAt/
    // lastError — it must never flip the operator's manual isActive toggle.
    await updateProxyPool(id, {
      testStatus: result.ok ? "active" : "error",
      lastTestedAt: now,
      lastError: result.ok ? null : (result.error || `Proxy test failed with status ${result.status}`),
      ...(exitIp ? { lastExitIp: exitIp, lastExitIpAt: now } : {}),
    });

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      statusText: result.statusText || null,
      error: result.error || null,
      elapsedMs: result.elapsedMs || 0,
      exitIp,
      exitIpError,
      testedAt: now,
    });
  } catch (error) {
    console.log("Error testing proxy pool:", error);
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}

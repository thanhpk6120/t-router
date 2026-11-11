"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import Card from "@/shared/components/Card";
import OverviewCards from "@/app/(dashboard)/dashboard/usage/components/OverviewCards";

// Recharts charts render client-only in this codebase (matches Usage page)
const UsageChart = dynamic(() => import("@/app/(dashboard)/dashboard/usage/components/UsageChart"), { ssr: false });
const TopModelsChart = dynamic(() => import("@/app/(dashboard)/dashboard/usage/components/TopModelsChart"), { ssr: false });
const ProviderBarChart = dynamic(() => import("@/app/(dashboard)/dashboard/usage/components/ProviderBarChart"), { ssr: false });

const PERIOD = "7d";

function fmtInt(n) {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}

function fmtUptime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Bar({ pct }) {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className="h-full rounded-full bg-gradient-to-r from-blue-600 via-sky-500 to-indigo-600"
        style={{ width: `${p}%` }}
      />
    </div>
  );
}

function MiniCard({ icon, color, label, value, sub }) {
  return (
    <Card className="flex min-w-0 flex-col gap-1 p-4">
      <span className="material-symbols-outlined text-[20px]" style={{ color }}>{icon}</span>
      <span className="text-xs text-text-muted">{label}</span>
      <span className="text-2xl font-extrabold tracking-tight text-white">{value}</span>
      {sub ? <span className="text-xs text-text-muted">{sub}</span> : null}
    </Card>
  );
}

export default function MonitoringPageClient() {
  const [stats, setStats] = useState(null);
  const [series, setSeries] = useState(null);
  const [mon, setMon] = useState(null);
  const [monError, setMonError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setMonError("");
    const [sRes, cRes, mRes] = await Promise.allSettled([
      fetch(`/api/usage/stats?period=${PERIOD}`),
      fetch(`/api/usage/chart?period=${PERIOD}`),
      fetch("/api/monitoring"),
    ]);
    if (sRes.status === "fulfilled" && sRes.value.ok) {
      try { setStats(await sRes.value.json()); } catch {}
    }
    if (cRes.status === "fulfilled" && cRes.value.ok) {
      try {
        const buckets = await cRes.value.json();
        if (Array.isArray(buckets)) {
          setSeries({
            requests: buckets.map((b) => b.requests || 0),
            tokens: buckets.map((b) => b.tokens || 0),
            cost: buckets.map((b) => b.cost || 0),
            cached: buckets.map((b) => b.cached || 0),
            completion: buckets.map((b) => b.completion || 0),
          });
        }
      } catch {}
    }
    if (mRes.status === "fulfilled" && mRes.value.ok) {
      try { setMon(await mRes.value.json()); } catch { setMonError("Failed to parse monitoring data."); }
    } else {
      setMonError("Failed to load monitoring data.");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const sys = mon?.system || null;
  const ramPct = sys && sys.memTotalBytes ? ((sys.memTotalBytes - sys.memFreeBytes) / sys.memTotalBytes) * 100 : null;
  const diskPct = sys?.disk && sys.disk.totalBytes
    ? (sys.disk.usedBytes / sys.disk.totalBytes) * 100
    : null;

  // Brand-new instance (no providers, no API keys yet): show the three first steps
  const isFreshInstall = !loading && !!mon
    && (mon.providers?.total || 0) === 0
    && (mon.keys?.total || 0) === 0;

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-white">Monitoring</h1>
          <p className="text-sm text-text-muted">Full system & gateway monitoring — last 7 days.</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
        >
          <span className="material-symbols-outlined text-[18px]">refresh</span>
          Refresh
        </button>
      </div>

      {isFreshInstall ? (
        <Card className="p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-[22px] text-primary">rocket_launch</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">Bắt đầu nhanh trong 1 phút — không cần thiết lập provider</p>
              <p className="mt-1 text-sm leading-6 text-text-muted">
                Router đã có thể trả lời thông qua luồng miễn phí (OpenCode Free). Bạn không cần có API key của provider nào để trải nghiệm.
              </p>
              <ol className="mt-3 flex flex-col gap-2 text-sm leading-6 text-text-muted">
                <li>
                  <span className="font-semibold text-white">1.</span>{" "}
                  <Link href="/dashboard/basic-chat" className="font-semibold text-primary underline">Trải nghiệm chat tại Basic Chat</Link>
                  {" "}— chọn model OpenCode Free và gửi tin nhắn đầu tiên.
                </li>
                <li>
                  <span className="font-semibold text-white">2.</span>{" "}
                  <Link href="/dashboard/endpoint" className="font-semibold text-primary underline">Tạo API key</Link>
                  {" "}— đoạn mã curl mẫu sẵn sàng sử dụng tại trang Endpoint &amp; Key.
                </li>
                <li>
                  <span className="font-semibold text-white">3.</span>{" "}
                  <Link href="/dashboard/providers" className="font-semibold text-primary underline">Kết nối nhà cung cấp</Link>
                  {" "}— khi bạn muốn sử dụng các model trả phí hoặc tài khoản riêng.
                </li>
              </ol>
            </div>
          </div>
        </Card>
      ) : null}

      {stats ? (
        <OverviewCards stats={stats} series={series} />
      ) : (
        <Card className="p-4 text-sm text-text-muted">
          {loading ? "Loading usage statistics..." : "Failed to load usage statistics."}
        </Card>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-blue-400">memory</span>
            <span className="text-sm font-semibold text-white">System Specs</span>
            {sys?.hostname ? (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-text-muted">{sys.hostname}</span>
            ) : null}
            {sys?.os ? (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-text-muted">{sys.os}</span>
            ) : null}
          </div>
          {!sys && !loading ? (
            <p className="text-sm text-text-muted">System data unavailable.</p>
          ) : !sys ? (
            <p className="text-sm text-text-muted">Loading...</p>
          ) : (
            <>
              <div>
                <p className="text-sm font-medium text-white">{sys.cpuModel || "Unknown CPU"}</p>
                <p className="text-xs text-text-muted">
                  {sys.cpuCores ? `${sys.cpuCores} cores` : "—"} · Load {sys.load?.map((v) => v.toFixed(2)).join(" / ") || "—"}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between text-xs text-text-muted">
                  <span>RAM</span>
                  <span>{fmtBytes(sys.memTotalBytes - sys.memFreeBytes)} / {fmtBytes(sys.memTotalBytes)}{ramPct !== null ? ` (${ramPct.toFixed(0)}%)` : ""}</span>
                </div>
                <Bar pct={ramPct} />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between text-xs text-text-muted">
                  <span>Disk /</span>
                  <span>
                    {sys.disk
                      ? `${fmtBytes(sys.disk.usedBytes)} / ${fmtBytes(sys.disk.totalBytes)}${diskPct !== null ? ` (${diskPct.toFixed(0)}%)` : ""}`
                      : "—"}
                  </span>
                </div>
                <Bar pct={diskPct} />
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-muted">
                <span>System Uptime: <span className="text-white">{fmtUptime(sys.uptimeSec)}</span></span>
                <span>App Uptime: <span className="text-white">{fmtUptime(sys.appUptimeSec)}</span></span>
              </div>
            </>
          )}
          {mon?.health ? (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-muted">
              <span>
                Database:{" "}
                <span className={mon.health.db === "ok" ? "text-emerald-400" : "text-red-400"}>
                  {mon.health.db === "ok" ? "● OK" : "● Error"}
                </span>
              </span>
              <span>
                Open Breakers: <span className="text-white">{fmtInt(mon.health.breakersOpen)}</span>
              </span>
            </div>
          ) : null}
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <Card className="flex min-w-0 flex-1 flex-col gap-1 p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-amber-400">bolt</span>
              <span className="text-sm font-semibold text-white">Fastest Provider</span>
            </div>
            {mon?.fastest ? (
              <>
                <span className="text-xl font-extrabold tracking-tight text-white">{mon.fastest.name}</span>
                <span className="text-sm text-text-muted">
                  <span className="font-bold text-white">{fmtInt(mon.fastest.p50Ms)} ms</span> p50 · {fmtInt(mon.fastest.samples)} samples · 7 days
                </span>
              </>
            ) : (
              <span className="text-sm text-text-muted">
                {loading ? "Loading..." : "No latency data in the last 7 days."}
              </span>
            )}
          </Card>
          <Card className="flex min-w-0 flex-1 flex-col gap-1 p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-blue-400">local_fire_department</span>
              <span className="text-sm font-semibold text-white">Most Used Provider</span>
            </div>
            {mon?.mostUsed ? (
              <>
                <span className="text-xl font-extrabold tracking-tight text-white">{mon.mostUsed.name}</span>
                <span className="text-sm text-text-muted">
                  <span className="font-bold text-white">{fmtInt(mon.mostUsed.requests)} requests</span>
                  {mon.mostUsed.sharePct !== null ? ` · ${mon.mostUsed.sharePct}% of total` : ""} · {fmtInt(mon.mostUsed.tokens)} tokens · 7 days
                </span>
              </>
            ) : (
              <span className="text-sm text-text-muted">
                {loading ? "Loading..." : "No provider usage in the last 7 days."}
              </span>
            )}
          </Card>
          <Card className="flex min-w-0 flex-1 flex-col gap-1 p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-amber-400">key</span>
              <span className="text-sm font-semibold text-white">Most Used API Key</span>
            </div>
            {mon?.mostUsedKey ? (
              <>
                <span className="text-xl font-extrabold tracking-tight text-white">{mon.mostUsedKey.name}</span>
                <span className="text-sm text-text-muted">
                  <span className="font-bold text-white">{fmtInt(mon.mostUsedKey.requests)} requests</span>
                  {mon.mostUsedKey.sharePct !== null ? ` · ${mon.mostUsedKey.sharePct}% of total` : ""} · {fmtInt(mon.mostUsedKey.tokens)} tokens · 7 days
                  {mon.mostUsedKey.provider ? ` · via ${mon.mostUsedKey.provider}` : ""}
                </span>
              </>
            ) : (
              <span className="text-sm text-text-muted">
                {loading ? "Loading..." : "No API key usage in the last 7 days."}
              </span>
            )}
          </Card>
          <Card className="flex min-w-0 flex-1 flex-col gap-1 p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-emerald-400">database</span>
              <span className="text-sm font-semibold text-white">Provider with Most Keys</span>
            </div>
            {mon?.mostKeys ? (
              <>
                <span className="text-xl font-extrabold tracking-tight text-white">{mon.mostKeys.name}</span>
                <span className="text-sm text-text-muted">
                  <span className="font-bold text-white">{fmtInt(mon.mostKeys.total)} connections</span>
                  {` · ${fmtInt(mon.mostKeys.active)} active`}
                  {mon.mostKeys.sharePct !== null ? ` · ${mon.mostKeys.sharePct}% of total` : ""}
                </span>
              </>
            ) : (
              <span className="text-sm text-text-muted">
                {loading ? "Loading..." : "No provider connections."}
              </span>
            )}
          </Card>
        </div>
      </div>

      {monError ? (
        <Card className="p-4 text-sm text-red-400">{monError}</Card>
      ) : mon ? (
        <div className="grid min-w-0 grid-cols-2 gap-4 lg:grid-cols-4">
          <MiniCard icon="dns" color="#3B82F6" label="Total Providers" value={fmtInt(mon.providers?.total)} sub={`${fmtInt(mon.providers?.active)} active`} />
          <MiniCard icon="lan" color="#0EA5E9" label="Total Proxies" value={fmtInt(mon.proxies?.totalProxies)} sub={`${fmtInt(mon.proxies?.pools)} pools · ${fmtInt(mon.proxies?.activePools)} active`} />
          <MiniCard icon="layers" color="#8B5CF6" label="Total Combos" value={fmtInt(mon.combos?.total)} sub="saved combos" />
          <MiniCard icon="key" color="#F59E0B" label="Total API Keys" value={fmtInt(mon.keys?.total)} sub="saved keys" />
        </div>
      ) : null}

      <UsageChart period={PERIOD} />
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        {stats?.byModel ? <TopModelsChart byModel={stats.byModel} /> : null}
        {stats?.byProvider ? (
          <ProviderBarChart byProvider={stats.byProvider} providerNames={mon?.providerNames || {}} />
        ) : null}
      </div>
    </div>
  );
}

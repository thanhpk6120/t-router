"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";

function fmtMs(v) {
  if (v === null || v === undefined) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

const MAP = { today: "24h", "24h": "24h", "7d": "7d", "30d": "30d", "60d": "all", all: "all", custom: "all" };

export default function LatencyCard({ period = "7d" }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/usage/latency?period=${MAP[period] || "7d"}`);
      if (!res.ok) throw new Error("failed");
      setData(await res.json());
      setError("");
    } catch {
      setError("Latency stats unavailable");
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const providers = data ? Object.entries(data.byProvider || {}).sort((a, b) => b[1].samples - a[1].samples).slice(0, 5) : [];

  return (
    <Card title="Latency" subtitle="TTFT + total time, p50/p95 from request details" icon="speed">
      {error && <p className="text-xs text-red-500">{error}</p>}
      {!data && !error && <p className="text-xs text-text-muted">Loading…</p>}
      {data && data.samples === 0 && (
        <div>
          <p className="text-xs text-text-muted">No latency data yet — it accrues from requests served after this feature landed.</p>
          <a href="/dashboard/endpoint" className="mt-1 inline-block text-xs font-medium text-primary hover:underline">
            Send a request, then check back →
          </a>
        </div>
      )}
      {data && data.samples > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-6 text-sm">
            <span>Requests <b className="font-mono">{data.samples}</b></span>
            <span>TTFT p50 <b className="font-mono">{fmtMs(data.ttft.p50)}</b></span>
            <span>TTFT p95 <b className="font-mono">{fmtMs(data.ttft.p95)}</b></span>
            <span>Total p50 <b className="font-mono">{fmtMs(data.total.p50)}</b></span>
            <span>Total p95 <b className="font-mono">{fmtMs(data.total.p95)}</b></span>
          </div>
          {providers.length > 0 && (
            <div className="overflow-x-auto pt-2">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-text-muted">
                    <th className="py-1">Top providers</th>
                    <th className="py-1 text-right">Samples</th>
                    <th className="py-1 text-right">TTFT p50</th>
                    <th className="py-1 text-right">Total p50</th>
                    <th className="py-1 text-right">Total p95</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map(([name, p]) => (
                    <tr key={name} className="border-b border-border/50">
                      <td className="py-1 font-mono">{name}</td>
                      <td className="py-1 text-right font-mono">{p.samples}</td>
                      <td className="py-1 text-right font-mono">{fmtMs(p.ttftP50)}</td>
                      <td className="py-1 text-right font-mono">{fmtMs(p.totalP50)}</td>
                      <td className="py-1 text-right font-mono">{fmtMs(p.totalP95)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

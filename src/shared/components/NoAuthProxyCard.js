"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";
import Toggle from "./Toggle";
const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
  { value: "fallback", label: "Fallback (Priority)" },
];
const PROXY_SOURCES = [
  { value: "both", label: "Both (Static + Rotating)" },
  { value: "rotating", label: "Rotating Proxies Only" },
  { value: "static", label: "Static Proxies Only" },
];


export default function NoAuthProxyCard({ providerId, isNoAuth = false }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [selectedPoolIds, setSelectedPoolIds] = useState([]);
  const [proxySource, setProxySource] = useState("both");
  const [poolSearch, setPoolSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateResult, setRotateResult] = useState(null);
  const [providerActive, setProviderActive] = useState(true);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      setRotateStrategy(override.rotateStrategy || "none");
      setSelectedPoolIds(Array.isArray(override.proxyPoolIds) ? override.proxyPoolIds : []);
      setProxySource(override.proxySource || "both");
      setProviderActive(override.isActive !== false && override.disabled !== true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const save = useCallback(async (poolId, strategy, poolIds, source = proxySource) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (poolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = poolId;
      if (strategy === "none") delete override.rotateStrategy;
      else override.rotateStrategy = strategy;
      if (Array.isArray(poolIds) && poolIds.length > 0) override.proxyPoolIds = poolIds;
      else delete override.proxyPoolIds;
      if (source && source !== "both") override.proxySource = source;
      else delete override.proxySource;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxy config error:", e);
    } finally {
      setSaving(false);
    }
  }, [providerId, proxySource]);

  const handleToggleActive = async (val) => {
    setProviderActive(val);
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      override.isActive = val;
      override.disabled = !val;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: { ...current, [providerId]: override } }),
      });
      await fetch("/api/providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, authTypes: ["free"], isActive: val }),
      }).catch(() => {});
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Toggle provider active error:", e);
    } finally {
      setSaving(false);
    }
  };
  const handlePoolChange = (newPoolId) => {
    setProxyPoolId(newPoolId);
    save(newPoolId, rotateStrategy, selectedPoolIds, proxySource);
  };

  const handleSourceChange = (newSource) => {
    setProxySource(newSource);
    save(proxyPoolId, rotateStrategy, selectedPoolIds, newSource);
  };

  const handleStrategyChange = (newStrategy) => {
    setRotateStrategy(newStrategy);
    if (newStrategy !== "none") setPickerOpen(true);
    save(proxyPoolId, newStrategy, selectedPoolIds, proxySource);
  };

  const applySelection = (ids) => {
    setSelectedPoolIds(ids);
    save(proxyPoolId, rotateStrategy, ids, proxySource);
  };

  const togglePool = (id) => {
    applySelection(selectedPoolIds.includes(id)
      ? selectedPoolIds.filter((x) => x !== id)
      : [...selectedPoolIds, id]);
  };

  const filteredPools = proxyPools.filter((pool) =>
    (pool.name || "").toLowerCase().includes(poolSearch.trim().toLowerCase()));

  const canRotate = proxyPools.length >= 2;
  const isRotation = rotateStrategy !== "none";
  const selectedPool = proxyPools.find((p) => p.id === proxyPoolId);

  const handleQuickRotate = async () => {
    if (!selectedPool?.id) return;
    setRotating(true);
    setRotateResult(null);
    try {
      const res = await fetch(`/api/proxy-pools/${selectedPool.id}/rotate`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setRotateResult({ ok: true, msg: data.response ? `Rotated: ${data.response.slice(0, 80)}` : "IP rotated successfully" });
      } else {
        setRotateResult({ ok: false, msg: data.error || "Failed to rotate" });
      }
    } catch (e) {
      setRotateResult({ ok: false, msg: e.message });
    } finally {
      setRotating(false);
      setTimeout(() => setRotateResult(null), 4000);
    }
  };
  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className={`inline-flex items-center justify-center w-10 h-10 rounded-full ${isNoAuth ? "bg-green-500/10 text-green-500" : "bg-primary/10 text-primary"}`}>
          <span className="material-symbols-outlined text-[20px]">{isNoAuth ? "lock_open" : "lan"}</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">{isNoAuth ? "OpenCode Free & Proxy Settings" : "Proxy Pool & Rotation"}</p>
          <p className="text-xs text-text-muted">
            {isNoAuth
              ? "Free tier AI service. Toggle this provider on/off, or route requests through your own proxy pool."
              : "Route requests for this provider through a proxy pool or rotate across multiple proxies (round-robin / random / fallback) automatically."}
          </p>
        </div>
        {isNoAuth && (
          <div className="flex items-center gap-2 mr-2">
            <span className="text-xs text-text-muted font-medium">{providerActive ? "Active" : "Disabled"}</span>
            <Toggle checked={providerActive} onChange={handleToggleActive} disabled={saving} />
          </div>
        )}
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      <Select
        label="Proxy Pool"
        value={proxyPoolId}
        onChange={(e) => handlePoolChange(e.target.value)}
        disabled={saving || isRotation}
        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({
            value: pool.id,
            label: `${pool.name}${pool.id === "direct" ? " [Direct / No Proxy]" : ""}${pool.rotateLink || pool.rotateUrl ? " [🔄 Rotating IP]" : ""}`,
          })),
        ]}
        hint={isRotation ? (selectedPoolIds.length > 0 ? "Rotating through the selected pools." : "Pool selector is ignored when rotation is active — all active pools are used.") : undefined}
      />
      {selectedPool && (selectedPool.rotateLink || selectedPool.rotateUrl) && !isRotation && (
        <div className="flex items-center justify-between gap-2 mt-2 p-2 rounded-lg bg-sky-500/5 border border-sky-500/20 text-xs">
          <div className="flex items-center gap-1.5 min-w-0 text-text-muted">
            <span className="material-symbols-outlined text-[16px] text-sky-500">sync</span>
            <span className="truncate">Rotate Link: <span className="font-mono text-sky-600 dark:text-sky-400">{selectedPool.rotateLink || selectedPool.rotateUrl}</span></span>
          </div>
          <button
            type="button"
            onClick={handleQuickRotate}
            disabled={rotating}
            className="shrink-0 px-2.5 py-1 rounded bg-sky-500 text-white font-medium hover:bg-sky-600 disabled:opacity-50 flex items-center gap-1 transition-all"
          >
            <span className="material-symbols-outlined text-[14px]" style={rotating ? { animation: "spin 1s linear infinite" } : undefined}>
              {rotating ? "progress_activity" : "sync"}
            </span>
            {rotating ? "Rotating..." : "Rotate IP"}
          </button>
        </div>
      )}
      {rotateResult && (
        <p className={`text-xs mt-1.5 ${rotateResult.ok ? "text-green-500" : "text-red-500"}`}>
          {rotateResult.msg}
        </p>
      )}

      <div className="flex flex-col gap-2 mt-4">
        <label className="text-sm font-medium text-text-main">Rotation Strategy</label>
        <select
          value={rotateStrategy}
          onChange={(e) => handleStrategyChange(e.target.value)}
          disabled={saving}
          className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
        >
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">
          {!canRotate
            ? "Need at least 2 active proxy pools for rotation."
            : isRotation && selectedPoolIds.length > 0
              ? <>{"Rotating through the "}{selectedPoolIds.length}{" selected pools."}</>
              : isRotation
                ? rotateStrategy === "round-robin"
                  ? <>{"Rotating through all "}{proxyPools.length}{" active pools in order. State is in-memory (resets on restart)."}</>
                  : rotateStrategy === "random"
                    ? <>{"Picking a random pool from "}{proxyPools.length}{" active pools each request."}</>
                    : <>{"Trying active pools in priority order (Fallback)."}</>
                : "Uses the selected pool above. Set to Round-robin, Random, or Fallback to rotate across active pools."}
        </p>
      </div>
      {isRotation && (
        <div className="flex flex-col gap-2 mt-4">
          <label className="text-sm font-medium text-text-main">Proxy Source</label>
          <select
            value={proxySource}
            onChange={(e) => handleSourceChange(e.target.value)}
            disabled={saving}
            className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
          >
            {PROXY_SOURCES.map((ps) => (
              <option key={ps.value} value={ps.value}>{ps.label}</option>
            ))}
          </select>
          <p className="text-xs text-text-muted">
            Filter which pools are eligible for rotation (both, rotating-only, or static-only).
          </p>
        </div>
      )}

      {isRotation && (
        <div className="flex flex-col gap-2 mt-4">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-expanded={pickerOpen}
            className="flex items-center justify-between w-full text-left"
          >
            <span className="text-sm font-medium text-text-main">Rotation pools</span>
            <span className="flex items-center gap-1 text-xs text-text-muted">
              {selectedPoolIds.length > 0 ? <>{selectedPoolIds.length}{" pools selected"}</> : "All active pools"}
              <span className="material-symbols-outlined text-[18px]">{pickerOpen ? "expand_less" : "expand_more"}</span>
            </span>
          </button>
          {pickerOpen && (
            <>
              <input
                value={poolSearch}
                onChange={(e) => setPoolSearch(e.target.value)}
                placeholder="Search pools…"
                className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
              />
              <div className="flex gap-3">
                <button type="button" onClick={() => applySelection([...new Set([...selectedPoolIds, ...filteredPools.map((p) => p.id)])])} className="text-xs font-medium text-primary hover:underline">Select all shown</button>
                <button type="button" onClick={() => applySelection([])} className="text-xs font-medium text-text-muted hover:underline">Clear selection</button>
              </div>
              <div className="max-h-44 overflow-y-auto border border-black/10 dark:border-white/10 rounded-md divide-y divide-black/5 dark:divide-white/5">
                {filteredPools.slice(0, 100).map((pool) => (
                  <label key={pool.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5">
                    <input type="checkbox" checked={selectedPoolIds.includes(pool.id)} onChange={() => togglePool(pool.id)} className="h-4 w-4 shrink-0 accent-primary" />
                    <span className="text-sm text-text-main truncate flex-1">{pool.name}</span>
                    {(pool.rotateLink || pool.rotateUrl) && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium">rotate</span>
                    )}
                  </label>
                ))}
                {filteredPools.length === 0 && (
                  <p className="px-3 py-2 text-xs text-text-muted">No pools match your search</p>
                )}
              </div>
              {filteredPools.length > 100 && (
                <p className="text-xs text-text-muted">Showing first 100 matches — refine your search</p>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setPickerOpen(false)}
                  className="px-4 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:opacity-90 transition"
                >
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  isNoAuth: PropTypes.bool,
};

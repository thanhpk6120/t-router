"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Card, Badge } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

// Mirrors the server-side gate in /api/providers/[id]/overrides — client check is UX only
const BLOCKED_HEADERS = ["host", "content-length", "content-type", "connection", "transfer-encoding", "authorization", "cookie"];
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
// Same caps as open-sse/config/runtimeConfig.js (TTFT_TIMEOUT_MAX_MS / TTFT_LADDER_MAX_LEN).
// A rung above the cap is rejected rather than clamped so the user sees why.
const LADDER_MAX_SECONDS = 60;
const LADDER_MAX_LEN = 6;

// "5, 10,30" → [5,10,30]. Returns null when the text is valid-but-empty (= off),
// throws a user-facing message when it is malformed.
function parseLadder(text) {
  const raw = (text || "").trim();
  if (!raw) return null;
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) throw new Error(`"${part}" is not a whole number of seconds`);
    const n = Number(part);
    if (n <= 0) throw new Error("Every ladder step must be greater than 0");
    if (n > LADDER_MAX_SECONDS) throw new Error(`Every ladder step must be at most ${LADDER_MAX_SECONDS}s`);
    out.push(n);
  }
  if (out.length > LADDER_MAX_LEN) throw new Error(`At most ${LADDER_MAX_LEN} ladder steps`);
  return out;
}

export default function CustomConfigCard({ providerId }) {
  const notify = useNotificationStore();
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState([{ name: "", value: "" }]);
  const [builtin, setBuiltin] = useState({});
  const [hasOverride, setHasOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ladderText, setLadderText] = useState("");
  const [hasLadder, setHasLadder] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/providers/${providerId}/overrides`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        // Effective set = registry built-ins with user overrides layered on top
        const builtinHeaders = data.builtinHeaders || {};
        const effective = { ...builtinHeaders, ...(data.headers || {}) };
        const headerRows = Object.entries(effective).map(([name, value]) => ({ name, value }));
        setBuiltin(builtinHeaders);
        setRows(headerRows.length ? headerRows : [{ name: "", value: "" }]);
        setHasOverride(Object.keys(data.headers || {}).length > 0);
        const ladder = Array.isArray(data.timeoutLadder) ? data.timeoutLadder : [];
        setLadderText(ladder.join(", "));
        setHasLadder(ladder.length > 0);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const setRow = (i, field, value) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  };

  const save = useCallback(async () => {
    // Diff-on-save: only rows differing from the registry default become overrides,
    // so a code-side registry bump still wins for everything the user left alone.
    const headers = {};
    for (const r of rows.filter((r) => r.name.trim())) {
      const name = r.name.trim();
      if (!HEADER_NAME_RE.test(name)) {
        notify.error(`Invalid header name: ${name}`);
        return;
      }
      if (BLOCKED_HEADERS.includes(name.toLowerCase())) {
        notify.error(`Header ${name} cannot be overridden`);
        return;
      }
      if (name in headers) {
        notify.error(`Duplicate header name: ${name}`);
        return;
      }
      if (r.value !== builtin[name]) headers[name] = r.value;
    }

    let timeoutLadder;
    try {
      timeoutLadder = parseLadder(ladderText);
    } catch (err) {
      notify.error(err.message);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/providers/${providerId}/overrides`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // An empty array is the server's "feature off" value (deletes the field).
        body: JSON.stringify({ headers, timeoutLadder: timeoutLadder || [] }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        notify.error(err.error || "Failed to save");
        return;
      }
      setHasOverride(Object.keys(headers).length > 0);
      setHasLadder((timeoutLadder || []).length > 0);
      notify.success("Custom config saved");
    } finally {
      setSaving(false);
    }
  }, [rows, builtin, providerId, notify, ladderText]);

  const resetToBuiltin = () => {
    setRows(Object.entries(builtin).map(([name, value]) => ({ name, value })));
  };

  // Always render: any provider can take a TTFT ladder even when it has no
  // registry headers to override.
  const active = hasOverride || hasLadder;

  return (
    <Card padding="xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[20px]">tune</span>
          <span className="text-sm font-semibold">Custom Config</span>
          {active && (
            <Badge variant="success" size="sm">Active</Badge>
          )}
        </div>
        <span className="material-symbols-outlined text-text-muted">
          {expanded ? "expand_less" : "expand_more"}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex flex-col gap-2">
            {rows.map((row, i) => {
              const overridden = row.name.trim() in builtin && row.value !== builtin[row.name.trim()];
              return (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={row.name}
                    onChange={(e) => setRow(i, "name", e.target.value)}
                    placeholder="Header-Name"
                    spellCheck={false}
                    className="w-44 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
                  />
                  <input
                    value={row.value}
                    onChange={(e) => setRow(i, "value", e.target.value)}
                    placeholder="Value"
                    spellCheck={false}
                    title={overridden ? "Overridden" : row.name.trim() in builtin ? "Registry default" : ""}
                    className={`min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none ${
                      overridden ? "border-amber-400/60" : "border-border"
                    }`}
                  />
                  <button
                    type="button"
                    title="Remove header"
                    onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [{ name: "", value: "" }]))}
                    className="shrink-0 text-text-muted hover:text-red-500"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              );
            })}
          </div>

          <div className="mt-4 rounded-md border border-border bg-black/[0.02] p-3 dark:bg-white/[0.02]">
            <label htmlFor="ttft-ladder" className="text-xs font-semibold">
              TTFT timeout ladder (seconds)
            </label>
            <input
              id="ttft-ladder"
              value={ladderText}
              onChange={(e) => setLadderText(e.target.value)}
              placeholder="e.g. 5, 10, 30"
              spellCheck={false}
              className="mt-1.5 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
              Number of attempts = number of values. Each expired step retries the{" "}
              <strong>same account</strong> with the next value. Each step measures time until the{" "}
              <strong>first token</strong> — a stream that already produced output is a success and is
              never cut. Max {LADDER_MAX_SECONDS}s per step, {LADDER_MAX_LEN} steps. Leave empty to
              disable.
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              Inside a combo, the member budget (60s by default) aborts the ladder first. A long
              ladder only pays off when this provider is called directly.
            </p>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setRows((prev) => [...prev, { name: "", value: "" }])}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add header
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={resetToBuiltin}
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-black/[0.03] dark:hover:bg-white/[0.03] disabled:opacity-50"
              >
                Reset
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={save}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

CustomConfigCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};

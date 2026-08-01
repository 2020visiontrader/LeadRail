'use client';
import { useEffect, useRef, useState } from 'react';

// Live system feed — the Jarvis "RT-LOG". Polls the durable app_logs stream
// (every API action: method, route, status, latency, actor) and renders it as a
// scrolling ticker with a pulsing "live" indicator. Admin/owner only; on 403 it
// quietly hides rather than nagging a non-admin.
interface LogRow {
  id: string;
  level: 'info' | 'warn' | 'error';
  route?: string;
  method?: string;
  status?: number;
  duration_ms?: number;
  actor_email?: string;
  message?: string;
  created_at: string;
}

const POLL_MS = 15_000;

export default function ActivityFeed() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [counts, setCounts] = useState<{ warn: number; error: number }>({ warn: 0, error: 0 });
  const [state, setState] = useState<'loading' | 'ok' | 'forbidden' | 'error'>('loading');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/logs?limit=30&sinceMinutes=1440', { headers: { Accept: 'application/json' } });
      if (res.status === 403) { setState('forbidden'); return; }
      if (!res.ok) { setState('error'); return; }
      const data = await res.json();
      setRows(Array.isArray(data.logs) ? data.logs : []);
      setCounts({ warn: data.counts?.warn || 0, error: data.counts?.error || 0 });
      setState('ok');
    } catch { setState('error'); }
  };

  useEffect(() => {
    load();
    timer.current = setInterval(load, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  if (state === 'forbidden') return null;

  return (
    <div className="flex h-full flex-col rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border-default)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--status-positive)] opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--status-positive)]" />
          </span>
          <h3 className="text-sm font-semibold">Live activity</h3>
        </div>
        <div className="flex items-center gap-1.5 text-[11px]">
          {counts.error > 0 && (
            <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 font-semibold text-[var(--status-negative)]">{counts.error} err</span>
          )}
          {counts.warn > 0 && (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-semibold text-amber-500">{counts.warn} warn</span>
          )}
        </div>
      </div>

      {/* Stream */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {state === 'loading' && <p className="px-2 py-6 text-center text-xs text-[var(--text-muted)]">Connecting…</p>}
        {state === 'error' && <p className="px-2 py-6 text-center text-xs text-[var(--text-muted)]">Feed unavailable.</p>}
        {state === 'ok' && rows.length === 0 && <p className="px-2 py-6 text-center text-xs text-[var(--text-muted)]">No activity in the last 24h.</p>}
        {state === 'ok' && rows.map((r) => (
          <div key={r.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--bg-raised)]">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot(r)}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                {r.method && <span className="font-mono text-[10px] font-semibold text-[var(--text-muted)]">{r.method}</span>}
                <span className="truncate font-mono text-xs text-[var(--text-secondary)]">{r.route || r.message || '—'}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                <span>{clock(r.created_at)}</span>
                {typeof r.status === 'number' && <span className={statusColor(r.status)}>{r.status}</span>}
                {typeof r.duration_ms === 'number' && <span>{r.duration_ms}ms</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function dot(r: LogRow) {
  if (r.level === 'error' || (r.status && r.status >= 500)) return 'bg-[var(--status-negative)]';
  if (r.level === 'warn' || (r.status && r.status >= 400)) return 'bg-amber-500';
  return 'bg-[var(--status-positive)]';
}
function statusColor(s: number) {
  if (s >= 500) return 'text-[var(--status-negative)]';
  if (s >= 400) return 'text-amber-500';
  return 'text-[var(--status-positive)]';
}
function clock(iso: string) {
  try { return new Date(iso).toLocaleTimeString('en-CA', { hour12: false }); } catch { return ''; }
}

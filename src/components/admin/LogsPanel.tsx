'use client';
import { Fragment, useState, useEffect, useCallback } from 'react';
import { apiGet } from '@/lib/api';

// Relocated from app/logs/page.tsx (formerly a standalone route with no role
// guard of its own — reachable, un-navigable, and 403'd only because /api/logs
// checks the session). It now lives as a tab inside /admin, so it inherits
// that page's owner-only gate instead of relying on the API's 403 to hide an
// otherwise-open page. Body kept as-is; only the export name and the
// forbidden-state copy below (unreachable in practice now, since the Admin
// page itself blocks non-owners before this ever mounts) are unchanged from
// the original.
interface LogRow {
  id: string;
  request_id: string | null;
  level: 'info' | 'warn' | 'error';
  route: string | null;
  method: string | null;
  status: number | null;
  duration_ms: number | null;
  actor_email: string | null;
  message: string | null;
  detail: any;
  created_at: string;
}

const LEVELS = ['all', 'error', 'warn', 'info'] as const;
const LEVEL_STYLE: Record<string, string> = {
  error: 'bg-red-100 text-red-700',
  warn: 'bg-amber-100 text-amber-700',
  info: 'bg-slate-100 text-slate-600',
};

export default function LogsPanel() {
  const [rows, setRows] = useState<LogRow[]>([]);
  // null = the rollup could not be read. NOT the same as zero, so the badges
  // below render a dash rather than a confident 0.
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('error');
  const [q, setQ] = useState('');
  const [sinceMinutes, setSinceMinutes] = useState(1440); // 24h
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '300', sinceMinutes: String(sinceMinutes) });
      if (level !== 'all') params.set('level', level);
      if (q.trim()) params.set('q', q.trim());
      const data = await apiGet<{ logs: LogRow[]; counts: Record<string, number> | null }>(`/api/logs?${params}`);
      setRows(data.logs || []);
      setCounts(data.counts ?? null);
      setForbidden(false);
    } catch (e: any) {
      if (String(e?.message || '').toLowerCase().includes('forbidden')) setForbidden(true);
      setRows([]);
      setCounts(null);
    } finally {
      setLoading(false);
    }
  }, [level, q, sinceMinutes]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 15_000); // live-ish refresh
    return () => clearInterval(t);
  }, [load]);

  if (forbidden) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold text-slate-900">Logs</h1>
        <p className="mt-4 text-sm text-slate-500">This page is available to account owners and admins only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Logs</h1>
          <p className="text-sm text-slate-500">Every API action, with errors and latency. Auto-refreshes every 15s.</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded-full bg-red-100 px-2.5 py-1 font-medium text-red-700">{counts ? counts.error ?? 0 : '—'} errors</span>
          <span className="rounded-full bg-amber-100 px-2.5 py-1 font-medium text-amber-700">{counts ? counts.warn ?? 0 : '—'} warns</span>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-slate-200">
          {LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`px-3 py-1.5 text-sm capitalize ${level === l ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {l}
            </button>
          ))}
        </div>
        <select
          value={sinceMinutes}
          onChange={(e) => setSinceMinutes(Number(e.target.value))}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700"
        >
          <option value={60}>Last hour</option>
          <option value={1440}>Last 24h</option>
          <option value={10080}>Last 7d</option>
          <option value={43200}>Last 30d</option>
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search message…"
          className="min-w-[200px] flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700"
        />
        <button onClick={load} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
          Refresh
        </button>
      </div>

      {loading && rows.length === 0 ? (
        <p className="text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-slate-400">No log entries match these filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2.5">Time</th>
                <th className="px-4 py-2.5">Level</th>
                <th className="px-4 py-2.5">Route</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">ms</th>
                <th className="px-4 py-2.5">Actor</th>
                <th className="px-4 py-2.5">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr
                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    className="cursor-pointer hover:bg-slate-50"
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-slate-500">{new Date(r.created_at).toLocaleTimeString()}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${LEVEL_STYLE[r.level]}`}>{r.level}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-700">
                      <span className="text-slate-400">{r.method}</span> {r.route}
                    </td>
                    <td className={`px-4 py-2 font-medium ${r.status && r.status >= 500 ? 'text-[var(--text-negative)]' : r.status && r.status >= 400 ? 'text-[var(--text-warning)]' : 'text-slate-500'}`}>
                      {r.status ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-slate-500">{r.duration_ms ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-500">{r.actor_email || 'system'}</td>
                    <td className="max-w-[280px] truncate px-4 py-2 text-slate-700">{r.message}</td>
                  </tr>
                  {expanded === r.id && (
                    <tr className="bg-slate-50">
                      <td colSpan={7} className="px-4 py-3">
                        <div className="mb-1 text-xs text-slate-400">request_id: {r.request_id || '—'}</div>
                        <pre className="max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
                          {JSON.stringify(r.detail ?? {}, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

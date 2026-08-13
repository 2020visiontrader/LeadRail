'use client';
import { useEffect, useState, useCallback } from 'react';
import Badge from '@/components/Badge';
import Button from '@/components/Button';
import LoadingSpinner from '@/components/LoadingSpinner';
import { apiGet } from '@/lib/api';

// Settings -> Diagnostics. Read-only, bounded snapshot from
// app/api/diagnostics — db reachability, env KEY presence (never values), and
// cheap per-table counts. Nothing here mutates state or calls an LLM.

interface CheckResult {
  name: string;
  status: 'ok' | 'error';
  detail: string;
}

interface DiagnosticsResponse {
  checks: CheckResult[];
  env: { key: string; present: boolean }[];
  counts: Record<string, number | null>;
}

const TABLE_LABELS: Record<string, string> = {
  ai_providers: 'AI providers',
  personas: 'Personas',
  account_skills: 'Skills',
  mcp_clients: 'MCP servers',
  scheduled_tasks: 'Scheduled tasks',
};

export default function Diagnostics() {
  const [data, setData] = useState<DiagnosticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await apiGet<DiagnosticsResponse>('/api/diagnostics');
      setData(res);
    } catch (e: any) {
      setErr(e?.message || 'Could not load diagnostics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Diagnostics</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            Read-only system snapshot: database reachability, configured environment keys, and record counts. Values
            are never shown — only presence.
          </p>
        </div>
        <Button variant="ghost" className="shrink-0 text-xs" onClick={load} loading={loading}>Refresh</Button>
      </div>

      {err && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : data ? (
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Checks</h3>
            <div className="overflow-hidden rounded-lg border border-[var(--border-default)]">
              <table className="w-full text-sm">
                <tbody>
                  {data.checks.map((c) => (
                    <tr key={c.name} className="border-b border-[var(--border-default)] last:border-0">
                      <td className="px-3 py-2 font-medium">{c.name}</td>
                      <td className="px-3 py-2"><Badge tone={c.status === 'ok' ? 'green' : 'red'}>{c.status}</Badge></td>
                      <td className="px-3 py-2 text-xs text-[var(--text-muted)]">{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Environment</h3>
            <div className="overflow-hidden rounded-lg border border-[var(--border-default)]">
              <table className="w-full text-sm">
                <tbody>
                  {data.env.map((e) => (
                    <tr key={e.key} className="border-b border-[var(--border-default)] last:border-0">
                      <td className="px-3 py-2 font-mono text-xs">{e.key}</td>
                      <td className="px-3 py-2"><Badge tone={e.present ? 'green' : 'gray'}>{e.present ? 'Set' : 'Missing'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Record counts</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.counts).map(([table, count]) => (
                <span key={table} className="rounded-full bg-[var(--bg-raised)] px-3 py-1 text-xs text-[var(--text-secondary)]">
                  {TABLE_LABELS[table] || table}: <span className="font-semibold text-[var(--text-primary)]">{count ?? '—'}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

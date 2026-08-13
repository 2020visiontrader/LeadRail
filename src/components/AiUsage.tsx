'use client';
import { useEffect, useState, useCallback } from 'react';
import Badge from '@/components/Badge';
import Dropdown from '@/components/Dropdown';
import LoadingSpinner from '@/components/LoadingSpinner';
import EmptyState from '@/components/EmptyState';
import KPICard from '@/components/KPICard';
import { apiGet } from '@/lib/api';

// Settings -> AI usage. Read-only view over the existing /api/ai/usage
// endpoint (getAiUsageSummary, lib/credits.ts) — per-model call/token totals
// for the Settings -> Models & providers usage picture. No writes, no new
// table; this just surfaces data that's already being recorded.

interface UsageRow {
  provider_id: string | null;
  model_id: string | null;
  model_label: string | null;
  calls: number;
  ok_calls: number;
  tokens_in: number;
  tokens_out: number;
}

const DAY_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export default function AiUsage() {
  const [days, setDays] = useState('30');
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const load = useCallback(async (windowDays: string) => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res = await apiGet<{ usage: UsageRow[] }>(`/api/ai/usage?days=${windowDays}`);
      setUsage(res.usage || []);
    } catch (e: any) {
      setErrMsg(e?.message || 'Could not load AI usage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [load, days]);

  const totalCalls = usage.reduce((sum, u) => sum + u.calls, 0);
  const totalOkCalls = usage.reduce((sum, u) => sum + u.ok_calls, 0);
  const totalTokensIn = usage.reduce((sum, u) => sum + u.tokens_in, 0);
  const totalTokensOut = usage.reduce((sum, u) => sum + u.tokens_out, 0);
  const successRate = totalCalls > 0 ? Math.round((totalOkCalls / totalCalls) * 100) : null;

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">AI usage</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            Read-only summary of AI calls made through LeadRail&apos;s provider registry, grouped by model.
          </p>
        </div>
        <div className="w-44 shrink-0">
          <Dropdown options={DAY_OPTIONS} value={days} onChange={(e) => setDays((e.target as HTMLSelectElement).value)} />
        </div>
      </div>

      {errMsg && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{errMsg}</div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : usage.length === 0 ? (
        <EmptyState icon="📊" title="No AI usage recorded yet" hint="Calls made through the provider registry will show up here." />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <KPICard label="Total calls" value={fmt(totalCalls)} sub={`in the last ${days} days`} />
            <KPICard label="Success rate" value={successRate !== null ? `${successRate}%` : '—'} />
            <KPICard label="Tokens in" value={fmt(totalTokensIn)} />
            <KPICard label="Tokens out" value={fmt(totalTokensOut)} />
          </div>

          <div className="overflow-x-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)]">
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--border-default)]">
                <tr>
                  <th className="px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Model</th>
                  <th className="px-2.5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Calls</th>
                  <th className="px-2.5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Success</th>
                  <th className="px-2.5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Tokens in</th>
                  <th className="px-2.5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Tokens out</th>
                  <th className="px-2.5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Total tokens</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u, i) => {
                  const rowRate = u.calls > 0 ? Math.round((u.ok_calls / u.calls) * 100) : null;
                  return (
                    <tr key={`${u.provider_id || 'none'}:${u.model_id || 'none'}:${i}`} className="border-b border-[var(--border-default)] last:border-0">
                      <td className="p-2.5">
                        <div className="font-medium text-[var(--text-primary)]">{u.model_label || u.model_id || 'Unknown model'}</div>
                        {u.model_id && u.model_label && u.model_id !== u.model_label && (
                          <div className="text-[11px] text-[var(--text-muted)]">{u.model_id}</div>
                        )}
                      </td>
                      <td className="p-2.5 text-right">{fmt(u.calls)}</td>
                      <td className="p-2.5 text-right">
                        {rowRate !== null ? <Badge tone={rowRate >= 95 ? 'green' : rowRate >= 80 ? 'amber' : 'red'}>{rowRate}%</Badge> : '—'}
                      </td>
                      <td className="p-2.5 text-right text-[var(--text-secondary)]">{fmt(u.tokens_in)}</td>
                      <td className="p-2.5 text-right text-[var(--text-secondary)]">{fmt(u.tokens_out)}</td>
                      <td className="p-2.5 text-right font-medium text-[var(--text-primary)]">{fmt(u.tokens_in + u.tokens_out)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

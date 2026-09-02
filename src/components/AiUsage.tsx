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
//
// TWO THINGS THIS PANEL USED TO STATE WRONGLY, both fixed here:
//
//  * A 7-day success rate hid recovery. OpenCode read "13%" on a week where
//    all 21 failures were five days old and all 3 successes were that
//    morning — healthy for days, displayed as dead. The Last ok / Last fail
//    columns are the two aggregates that separate "broken" from "was broken".
//
//  * The token totals were partial and labelled as totals. Providers that
//    report nothing (Zo Ask, always) contributed zero to a headline that read
//    as the sum of every call. The tiles now say "reported", name their
//    coverage, and show estimated tokens — our own figure for failed calls,
//    which no provider costs — beside the total rather than inside it.

interface UsageRow {
  provider_id: string | null;
  model_id: string | null;
  model_label: string | null;
  calls: number;
  ok_calls: number;
  /** Provider-reported only. See getAiUsageSummary in lib/credits.ts. */
  tokens_in: number;
  tokens_out: number;
  tokens_in_estimated: number;
  reported_calls: number;
  last_ok_at: string | null;
  last_failure_at: string | null;
}

const DAY_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** "3h ago" / "5d ago" — a rate averaged over a week cannot distinguish a
 *  provider that is broken from one that broke and recovered, so the two
 *  freshness stamps are rendered as elapsed time, which is the form that
 *  answers "is it down NOW". Absolute time stays in the title attribute. */
function ago(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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
  // Coverage, not decoration. Several providers report no usage at all (Zo
  // Ask never has), so the token totals are the sum of the providers that DO
  // report — labelling them "tokens in" full stop overstated what was
  // measured. `estimated` is our own figure for calls that failed and were
  // therefore never costed by anyone (lib/ai/router.ts::failureUsage); it is
  // shown beside the total, never inside it.
  const reportedCalls = usage.reduce((sum, u) => sum + u.reported_calls, 0);
  const estimatedTokensIn = usage.reduce((sum, u) => sum + u.tokens_in_estimated, 0);
  const coverage = totalCalls > 0
    ? `provider-reported for ${fmt(reportedCalls)} of ${fmt(totalCalls)} calls`
    : undefined;

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
            <KPICard
              label="Tokens in (reported)"
              value={fmt(totalTokensIn)}
              sub={[coverage, estimatedTokensIn > 0 ? `+${fmt(estimatedTokensIn)} estimated on failed calls` : null]
                .filter(Boolean).join(' · ')}
            />
            <KPICard label="Tokens out (reported)" value={fmt(totalTokensOut)} sub={coverage} />
          </div>

          <div className="overflow-x-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)]">
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--border-default)]">
                <tr>
                  <th className="px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Model</th>
                  <th className="px-2.5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Calls</th>
                  <th className="px-2.5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Success</th>
                  <th className="px-2.5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Last ok</th>
                  <th className="px-2.5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Last fail</th>
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
                      <td className="p-2.5 text-right text-[var(--text-secondary)]" title={u.last_ok_at || undefined}>{ago(u.last_ok_at)}</td>
                      <td className="p-2.5 text-right text-[var(--text-secondary)]" title={u.last_failure_at || undefined}>{ago(u.last_failure_at)}</td>
                      <td className="p-2.5 text-right text-[var(--text-secondary)]">
                        {fmt(u.tokens_in)}
                        {u.tokens_in_estimated > 0 && (
                          <div className="text-[11px] text-[var(--text-muted)]">+{fmt(u.tokens_in_estimated)} est.</div>
                        )}
                      </td>
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

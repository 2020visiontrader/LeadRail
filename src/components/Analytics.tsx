'use client';

import { useCallback, useEffect, useState } from 'react';
import Dropdown from '@/components/Dropdown';
import Chart from '@/components/Chart';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet } from '@/lib/api';

// Lightweight Postgres-only CDP dashboard (migration 031_events.sql).
// KPI totals + a by-type breakdown + a daily timeseries, all account-scoped.

interface Totals { contacts: number; events: number; events7d: number }
interface ByType { type: string; count: number }
interface TimeseriesPoint { date: string; count: number }
interface AnalyticsResponse { totals: Totals; byType: ByType[]; timeseries: TimeseriesPoint[] }

const RANGE_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

function KpiCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
      <p className="text-xs font-medium text-[var(--text-secondary)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-[var(--text-primary)]">{value}</p>
    </div>
  );
}

export default function Analytics() {
  const { notify } = useToast();
  const [days, setDays] = useState('30');
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (rangeDays: string) => {
    setLoading(true);
    try {
      const res = await apiGet<AnalyticsResponse>(`/api/analytics?days=${rangeDays}`);
      setData(res);
    } catch (e: any) {
      notify(e?.message || 'Failed to load analytics', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(days); }, [load, days]);

  // Collapse the daily timeseries into at most ~14 chart bars so it stays
  // readable at the 90-day range without needing a new chart component.
  const chartData = (() => {
    if (!data) return [];
    const points = data.timeseries;
    const maxBars = 14;
    if (points.length <= maxBars) {
      return points.map((p) => ({ label: p.date.slice(5), value: p.count }));
    }
    const bucketSize = Math.ceil(points.length / maxBars);
    const buckets: { label: string; value: number }[] = [];
    for (let i = 0; i < points.length; i += bucketSize) {
      const slice = points.slice(i, i + bucketSize);
      const total = slice.reduce((sum, p) => sum + p.count, 0);
      buckets.push({ label: slice[0].date.slice(5), value: total });
    }
    return buckets;
  })();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">Analytics</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Lightweight event tracking — contacts, activity totals, and a breakdown by event type.
          </p>
        </div>
        <Dropdown className="w-44" options={RANGE_OPTIONS} value={days} onChange={(e) => setDays((e.target as HTMLSelectElement).value)} />
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : !data ? (
        <EmptyState title="No analytics available" hint="Analytics needs the database configured." />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <KpiCard label="Total contacts" value={data.totals.contacts} />
            <KpiCard label="Total events" value={data.totals.events} />
            <KpiCard label="Events (last 7d)" value={data.totals.events7d} />
          </div>

          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
            <h2 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">Event volume</h2>
            {chartData.length === 0 || chartData.every((d) => d.value === 0) ? (
              <p className="text-xs text-[var(--text-muted)]">No events recorded in this range yet.</p>
            ) : (
              <Chart data={chartData} showValues />
            )}
          </div>

          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
            <h2 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">By event type</h2>
            {data.byType.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">No events recorded in this range yet.</p>
            ) : (
              <div className="divide-y divide-[var(--border-default)]">
                {data.byType.map((t) => (
                  <div key={t.type} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-[var(--text-primary)]">{t.type}</span>
                    <span className="font-medium text-[var(--text-secondary)]">{t.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

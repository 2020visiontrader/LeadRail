'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import KPICard from '@/components/KPICard';
import Chart from '@/components/Chart';
import LoadingSpinner from '@/components/LoadingSpinner';
import Badge from '@/components/Badge';
import { apiGet } from '@/lib/api';
import { Contact } from '@/lib/types';

interface Venture { id: string; name: string; account_id: string }

export default function Overview() {
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [venture, setVenture] = useState<Venture | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [recent, setRecent] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<{ ventures: Venture[] }>('/api/ventures')
      .then((d) => { const vs = d.ventures || []; setVentures(vs); setVenture((cur) => cur || vs[0] || null); })
      .catch(() => setVentures([]));
  }, []);

  useEffect(() => {
    if (!venture) return;
    setLoading(true);
    Promise.all([
      apiGet(`/api/overview?brandId=${venture.id}`).catch(() => null),
      apiGet<Contact[]>(`/api/leads?brandId=${venture.id}&limit=5`).catch(() => []),
    ]).then(([s, r]) => {
      setStats(s);
      setRecent(Array.isArray(r) ? r : []);
      setLoading(false);
    });
  }, [venture]);

  const segCounts = recent.reduce((acc: Record<string, number>, c) => {
    acc[c.segment] = (acc[c.segment] || 0) + 1;
    return acc;
  }, {});

  if (loading) return <LoadingSpinner label="Loading dashboard…" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        {ventures.length > 1 && (
          <select
            value={venture?.id || ''}
            onChange={(e) => setVenture(ventures.find((v) => v.id === e.target.value) || null)}
            className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            {ventures.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        )}
      </div>

      {!stats ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
          <p className="text-slate-500">No data yet — add leads to populate the dashboard.</p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KPICard label="Total Contacts" value={stats.contacts || 0} />
            <KPICard label="Active Deals" value={stats.deals || 0} icon="💼" />
            <KPICard label="Won" value={stats.won || 0} icon="✅" />
            <KPICard label="CVR" value={`${stats.conversion_rate || 0}%`} />
          </div>

          {Object.keys(segCounts).length > 0 && (
            <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4">
              <h3 className="mb-3 text-sm font-semibold">Lead segments</h3>
              <Chart
                data={Object.entries(segCounts).map(([seg, n]) => ({ label: seg, value: n }))}
                height={160}
              />
            </div>
          )}

          {recent.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Recent leads</h3>
              <div className="overflow-hidden rounded-lg border border-[var(--border-strong)]">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[var(--bg-raised)]">
                    <tr>
                      <th className="px-4 py-2 font-medium">Name</th>
                      <th className="px-4 py-2 font-medium">Company</th>
                      <th className="px-4 py-2 font-medium">Segment</th>
                      <th className="px-4 py-2 font-medium">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-weak)]">
                    {recent.map((c) => (
                      <tr key={c.id} className="hover:bg-[var(--bg-raised)]">
                        <td className="px-4 py-2">{c.name}</td>
                        <td className="px-4 py-2 text-[var(--text-secondary)]">{c.company || '—'}</td>
                        <td className="px-4 py-2"><Badge tone="blue">{c.segment}</Badge></td>
                        <td className="px-4 py-2 font-mono">{c.score}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <Link href="/leads" className="inline-flex items-center rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white hover:brightness-110">📋 View all leads</Link>
            <Link href="/outreach" className="inline-flex items-center rounded-lg bg-[var(--bg-raised)] px-4 py-2 text-sm font-medium hover:brightness-95">✉️ Send outreach</Link>
            <Link href="/campaigns" className="inline-flex items-center rounded-lg bg-[var(--bg-raised)] px-4 py-2 text-sm font-medium hover:brightness-95">🎯 New campaign</Link>
          </div>
        </>
      )}
    </div>
  );
}

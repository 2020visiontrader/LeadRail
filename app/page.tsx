'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import KPICard from '@/components/KPICard';
import Chart from '@/components/Chart';
import LoadingSpinner from '@/components/LoadingSpinner';
import Badge from '@/components/Badge';
import { apiGet } from '@/lib/api';
import { Contact } from '@/lib/types';

const BRAND = 'rentahub';

export default function Overview() {
  const [stats, setStats] = useState<any>(null);
  const [recent, setRecent] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiGet(`/api/overview?brandId=${BRAND}`).catch(() => null),
      apiGet<Contact[]>(`/api/leads?brandId=${BRAND}&limit=5`).catch(() => []),
    ]).then(([s, r]) => {
      setStats(s);
      setRecent(Array.isArray(r) ? r : []);
      setLoading(false);
    });
  }, []);

  const segCounts = recent.reduce((acc: Record<string, number>, c) => {
    acc[c.segment] = (acc[c.segment] || 0) + 1;
    return acc;
  }, {});
  const chartData = Object.entries(segCounts).map(([label, value]) => ({ label, value }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-sm text-slate-500">Your agency at a glance</p>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <KPICard label="Leads" value={stats?.leads ?? '—'} icon="📋" />
            <KPICard label="Avg Score" value={stats?.avgScore ?? '—'} icon="⭐" />
            <KPICard label="Emails Sent" value={stats?.emails ?? '—'} icon="📧" />
            <KPICard label="Scheduled Posts" value={stats?.posts ?? '—'} icon="📱" />
            <KPICard label="Ad Campaigns" value={stats?.campaigns ?? '—'} icon="🎯" />
          </div>
          {!stats && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Live stats need Supabase connected + migrations applied. Showing placeholders.
            </p>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-semibold">Recent Leads</h2>
                <Link href="/leads" className="text-sm text-indigo-600 hover:underline">View all →</Link>
              </div>
              {recent.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">No leads yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {recent.map((c) => (
                    <li key={c.id} className="flex items-center justify-between py-3">
                      <div>
                        <Link href={`/leads/${c.id}`} className="text-sm font-medium hover:text-indigo-600">{c.name}</Link>
                        <p className="text-xs text-slate-400">{c.company || c.email}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone="indigo">{c.segment}</Badge>
                        <span className="text-sm font-semibold text-green-600">{c.score}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="mb-4 font-semibold">Segment Mix (recent)</h2>
              {chartData.length ? <Chart data={chartData} /> : <p className="py-8 text-center text-sm text-slate-400">No data.</p>}
              <div className="mt-6 space-y-2">
                <Link href="/outreach" className="block rounded-lg bg-slate-50 px-3 py-2 text-sm hover:bg-slate-100">📧 Compose outreach</Link>
                <Link href="/content" className="block rounded-lg bg-slate-50 px-3 py-2 text-sm hover:bg-slate-100">📱 Schedule content</Link>
                <Link href="/campaigns" className="block rounded-lg bg-slate-50 px-3 py-2 text-sm hover:bg-slate-100">🎯 New campaign</Link>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

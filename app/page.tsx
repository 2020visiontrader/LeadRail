'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import KPICard from '@/components/KPICard';
import Chart from '@/components/Chart';
import LoadingSpinner from '@/components/LoadingSpinner';
import Badge from '@/components/Badge';
import Modal from '@/components/Modal';
import Input from '@/components/Input';
import Button from '@/components/Button';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import { Contact } from '@/lib/types';

interface Venture { id: string; name: string; account_id: string; contact_count?: number }
const ALL = 'all';

const money = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `$${n}`);

export default function Overview() {
  const { notify } = useToast();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [scopeId, setScopeId] = useState<string>(ALL); // 'all' or a brand id
  const [stats, setStats] = useState<any>(null);
  const [recent, setRecent] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const loadVentures = () =>
    apiGet<{ ventures: Venture[] }>('/api/ventures')
      .then((d) => { setVentures(d.ventures || []); return d.ventures || []; })
      .catch(() => { setVentures([]); return [] as Venture[]; });

  useEffect(() => {
    loadVentures().then((vs) => {
      // Default: wide "All Ventures" preview when >1 venture, else the single one.
      setScopeId((cur) => (cur !== ALL ? cur : vs.length === 1 ? vs[0].id : ALL));
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    const isAll = scopeId === ALL;
    Promise.all([
      apiGet(`/api/overview?brandId=${encodeURIComponent(scopeId)}`).catch(() => null),
      isAll ? Promise.resolve([]) : apiGet<Contact[]>(`/api/leads?brandId=${scopeId}&limit=8`).catch(() => []),
    ]).then(([s, r]) => {
      setStats(s);
      setRecent(Array.isArray(r) ? r : []);
      setLoading(false);
    });
  }, [scopeId, ventures.length]);

  const createVenture = async () => {
    const name = newName.trim();
    if (!name) { notify('Give the venture a name', 'error'); return; }
    setCreating(true);
    try {
      const { venture } = await apiSend<{ venture: Venture }>('/api/ventures', 'POST', { name });
      await loadVentures();
      setScopeId(venture.id);
      setAddOpen(false); setNewName('');
      notify(`Created “${venture.name}”`);
    } catch (e: any) { notify(e.message || 'Could not create venture', 'error'); }
    finally { setCreating(false); }
  };

  const scopeName = scopeId === ALL ? 'All Ventures' : ventures.find((v) => v.id === scopeId)?.name || '—';
  const segEntries = stats?.segments ? Object.entries(stats.segments as Record<string, number>) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <select
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            <option value={ALL}>🌐 All Ventures</option>
            {ventures.map((v) => (
              <option key={v.id} value={v.id}>{v.name}{v.contact_count ? ` (${v.contact_count})` : ''}</option>
            ))}
          </select>
        </div>
        <Button onClick={() => setAddOpen(true)}>+ New venture</Button>
      </div>

      {loading ? (
        <LoadingSpinner label="Loading dashboard…" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <KPICard label="Total Contacts" value={stats?.contacts ?? 0} />
            <KPICard label="Active Deals" value={stats?.deals ?? 0} icon="💼" />
            <KPICard label="Won" value={stats?.won ?? 0} icon="✅" />
            <KPICard label="CVR" value={`${stats?.conversion_rate ?? 0}%`} />
            <KPICard label="Revenue" value={money(stats?.revenue ?? 0)} icon="💰" />
          </div>

          {(stats?.contacts ?? 0) === 0 && (stats?.deals ?? 0) === 0 && (
            <div className="rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--bg-raised)] p-6 text-center text-sm text-[var(--text-secondary)]">
              No data yet for <b>{scopeName}</b> — add leads (Leads → Find Leads / Import) to populate this dashboard.
            </div>
          )}

          {segEntries.length > 0 && (
            <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4">
              <h3 className="mb-3 text-sm font-semibold">Lead segments — {scopeName}</h3>
              <Chart
                data={segEntries.map(([seg, n]) => ({ label: seg, value: n as number }))}
                height={180}
              />
            </div>
          )}

          {scopeId !== ALL && recent.length > 0 && (
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

          <div className="flex flex-wrap gap-3">
            <Link href="/leads" className="inline-flex items-center rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white hover:brightness-110">📋 View all leads</Link>
            <Link href="/outreach" className="inline-flex items-center rounded-lg bg-[var(--bg-raised)] px-4 py-2 text-sm font-medium hover:brightness-95">✉️ Send outreach</Link>
            <Link href="/campaigns" className="inline-flex items-center rounded-lg bg-[var(--bg-raised)] px-4 py-2 text-sm font-medium hover:brightness-95">🎯 New campaign</Link>
          </div>
        </>
      )}

      <Modal isOpen={addOpen} title="New venture" onClose={() => setAddOpen(false)} onSubmit={createVenture} submitLabel="Create venture" loading={creating}>
        <div className="space-y-3">
          <Input label="Venture name" placeholder="e.g. RetentionRail" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <p className="text-xs text-[var(--text-muted)]">A venture is a separate brand workspace — its own leads, sequences, inbox and outreach.</p>
        </div>
      </Modal>
    </div>
  );
}

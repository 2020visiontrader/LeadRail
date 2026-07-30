'use client';
import { useEffect, useState, useCallback } from 'react';
import Button from '@/components/Button';
import Dropdown from '@/components/Dropdown';
import Badge from '@/components/Badge';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import { Contact } from '@/lib/types';

interface Venture { id: string; name: string; account_id: string }
const verdictTone = (v?: string) => (v === 'good_fit' ? 'green' : v === 'maybe' ? 'amber' : v === 'skip' ? 'red' : 'gray');
const statusTone = (s?: string) => (s === 'done' ? 'green' : s === 'pending' ? 'amber' : s === 'failed' ? 'red' : 'gray');
const statusLabel = (s?: string) => (s === 'done' ? 'enriched' : s || 'none');

export default function EnrichmentPage() {
  const { notify } = useToast();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [venture, setVenture] = useState<Venture | null>(null);
  const [rows, setRows] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { apiGet<{ ventures: Venture[] }>('/api/ventures').then((d) => { setVentures(d.ventures || []); setVenture((c) => c || d.ventures?.[0] || null); }).catch(() => {}); }, []);

  const load = useCallback(async () => {
    if (!venture) return;
    setLoading(true);
    try { setRows(await apiGet<Contact[]>(`/api/leads?brandId=${venture.id}&limit=100`)); }
    catch { setRows([]); } finally { setLoading(false); }
  }, [venture]);
  useEffect(() => { load(); }, [load]);

  const enrich = async (c: Contact) => {
    setBusy(c.id);
    try { await apiSend(`/api/leads/${c.id}/enrich`, 'POST', { accountId: venture?.account_id }); notify(`Enriched ${c.name}`); load(); }
    catch (e: any) { notify(e.message === 'not_configured' ? 'Connect Apollo to enrich' : e.message || 'Enrich failed', 'error'); }
    finally { setBusy(null); }
  };
  const enrichPending = async () => {
    const pending = rows.filter((r) => (r.enrichment_status || 'none') !== 'done' && (r.enrichment_status || 'none') !== 'failed');
    if (!pending.length) { notify('Nothing pending'); return; }
    setBusy('all');
    let ok = 0;
    for (const c of pending.slice(0, 25)) { try { await apiSend(`/api/leads/${c.id}/enrich`, 'POST', { accountId: venture?.account_id }); ok++; } catch { /* keep going */ } }
    notify(`Enriched ${ok}/${pending.length}`); setBusy(null); load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-bold">Enrichment</h1><p className="text-sm text-slate-500">Deepen your list — verified email, seniority, org data, and a fit verdict.</p></div>
        <div className="flex items-center gap-2">
          <Dropdown value={venture?.id || ''} onChange={(e) => setVenture(ventures.find((v) => v.id === e.target.value) || null)} options={ventures.map((v) => ({ value: v.id, label: v.name }))} />
          <Button loading={busy === 'all'} onClick={enrichPending}>Enrich all pending</Button>
        </div>
      </div>
      {loading ? <LoadingSpinner /> : rows.length === 0 ? (
        <EmptyState icon="🔎" title="No leads to enrich" hint="Import or source leads first, then enrich them here." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600"><tr>
              <th className="p-3 text-left">Name</th><th className="p-3 text-left">Company</th><th className="p-3 text-left">Status</th><th className="p-3 text-left">Fit</th><th className="p-3 text-right">Action</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="p-3 font-medium">{c.name}<div className="text-xs text-slate-400">{c.title || '—'}</div></td>
                  <td className="p-3">{c.company || '—'}</td>
                  <td className="p-3"><Badge tone={statusTone(c.enrichment_status)}>{statusLabel(c.enrichment_status)}</Badge></td>
                  <td className="p-3">{c.fit_verdict ? <Badge tone={verdictTone(c.fit_verdict)}>{c.fit_verdict}</Badge> : '—'}</td>
                  <td className="p-3 text-right"><Button variant="secondary" loading={busy === c.id} onClick={() => enrich(c)}>Enrich</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

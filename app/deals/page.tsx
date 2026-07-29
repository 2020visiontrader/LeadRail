'use client';
import { useState, useEffect, useCallback } from 'react';
import Modal from '@/components/Modal';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Dropdown from '@/components/Dropdown';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import type { Deal, PipelineStage, Company } from '@/lib/types';

interface Venture { id: string; name: string; account_id: string }
const empty = { name: '', amount: '', company_id: '', stage_id: '' };

export default function DealsPage() {
  const { notify } = useToast();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [venture, setVenture] = useState<Venture | null>(null);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet<{ ventures: Venture[] }>('/api/ventures').then((d) => {
      const vs = d.ventures || []; setVentures(vs); setVenture((c) => c || vs[0] || null);
    }).catch(() => setVentures([]));
  }, []);

  const load = useCallback(async () => {
    if (!venture) return;
    setLoading(true);
    try {
      const [st, dl, co] = await Promise.all([
        apiGet<PipelineStage[]>(`/api/pipeline/stages?accountId=${venture.account_id}&brandId=${venture.id}`),
        apiGet<Deal[]>(`/api/deals?accountId=${venture.account_id}&brandId=${venture.id}`),
        apiGet<Company[]>(`/api/companies?accountId=${venture.account_id}&brandId=${venture.id}`),
      ]);
      setStages(Array.isArray(st) ? st : []); setDeals(Array.isArray(dl) ? dl : []); setCompanies(Array.isArray(co) ? co : []);
    } catch { setStages([]); setDeals([]); } finally { setLoading(false); }
  }, [venture]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!venture || !form.name.trim()) { notify('Deal name is required', 'error'); return; }
    setSaving(true);
    try {
      await apiSend('/api/deals', 'POST', {
        account_id: venture.account_id, brand_id: venture.id, name: form.name,
        amount: form.amount ? Number(form.amount) : undefined,
        company_id: form.company_id || undefined, stage_id: form.stage_id || stages[0]?.id,
      });
      notify('Deal created', 'success'); setAddOpen(false); setForm(empty); load();
    } catch (e: any) { notify(e.message || 'Failed', 'error'); } finally { setSaving(false); }
  };

  const move = async (deal: Deal, dir: -1 | 1) => {
    const ordered = [...stages].sort((a, b) => a.position - b.position);
    const idx = ordered.findIndex((s) => s.id === deal.stage_id);
    const next = ordered[idx + dir];
    if (!next) return;
    setDeals((ds) => ds.map((d) => d.id === deal.id ? { ...d, stage_id: next.id } : d)); // optimistic
    try { await apiSend(`/api/deals/${deal.id}/stage`, 'PATCH', { stage_id: next.id }); }
    catch (e: any) { notify(e.message || 'Move failed', 'error'); load(); }
  };

  const ordered = [...stages].sort((a, b) => a.position - b.position);
  const companyName = (id?: string) => companies.find((c) => c.id === id)?.name;

  return (
    <div className="mx-auto max-w-full">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Pipeline</h1>
          <p className="text-sm text-slate-500">Deals across your stages. Use ◀ ▶ to move a deal.</p>
        </div>
        <div className="flex items-center gap-3">
          <Dropdown value={venture?.id || ''} onChange={(e) => setVenture(ventures.find((v) => v.id === e.target.value) || null)}
            options={ventures.map((v) => ({ value: v.id, label: v.name }))} />
          <Button onClick={() => setAddOpen(true)}>+ Add Deal</Button>
        </div>
      </div>

      {loading ? <p className="text-slate-400">Loading…</p> : ordered.length === 0 ? <p className="text-slate-400">No pipeline stages configured.</p> : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {ordered.map((stage) => {
            const col = deals.filter((d) => d.stage_id === stage.id);
            const sum = col.reduce((n, d) => n + (Number(d.amount) || 0), 0);
            return (
              <div key={stage.id} className="w-72 shrink-0 rounded-xl bg-slate-100 p-3">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-700">{stage.name}</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-500">{col.length} · ${sum}</span>
                </div>
                <div className="space-y-2">
                  {col.map((d) => (
                    <div key={d.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                      <div className="text-sm font-medium text-slate-900">{d.name}</div>
                      <div className="text-xs text-slate-500">{companyName(d.company_id) || '—'} · {d.amount ? `$${d.amount}` : '—'}</div>
                      <div className="mt-2 flex justify-between">
                        <button onClick={() => move(d, -1)} className="text-slate-400 hover:text-indigo-600" title="Move back">◀</button>
                        <span className={`text-xs ${d.status === 'won' ? 'text-green-600' : d.status === 'lost' ? 'text-red-500' : 'text-slate-400'}`}>{d.status}</span>
                        <button onClick={() => move(d, 1)} className="text-slate-400 hover:text-indigo-600" title="Move forward">▶</button>
                      </div>
                    </div>
                  ))}
                  {col.length === 0 && <p className="py-4 text-center text-xs text-slate-400">Empty</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal isOpen={addOpen} title="Add Deal" onClose={() => setAddOpen(false)} onSubmit={save} submitLabel="Create" loading={saving}>
        <div className="space-y-3">
          <Input label="Deal name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input label="Amount ($)" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <Dropdown label="Company" value={form.company_id} onChange={(e) => setForm({ ...form, company_id: e.target.value })}
            options={[{ value: '', label: '— none —' }, ...companies.map((c) => ({ value: c.id, label: c.name }))]} />
          <Dropdown label="Stage" value={form.stage_id} onChange={(e) => setForm({ ...form, stage_id: e.target.value })}
            options={ordered.map((s) => ({ value: s.id, label: s.name }))} />
        </div>
      </Modal>
    </div>
  );
}

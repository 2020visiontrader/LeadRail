'use client';
import { useState, useEffect, useCallback } from 'react';
import Modal from '@/components/Modal';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Dropdown from '@/components/Dropdown';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import type { Company, Deal } from '@/lib/types';

interface Venture { id: string; name: string; account_id: string }
const empty = { name: '', domain: '', industry: '', website: '', location: '' };

export default function CompaniesPage() {
  const { notify } = useToast();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [venture, setVenture] = useState<Venture | null>(null);
  const [rows, setRows] = useState<Company[]>([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Company | null>(null);
  const [dealsFor, setDealsFor] = useState<Deal[]>([]);

  useEffect(() => {
    apiGet<{ ventures: Venture[] }>('/api/ventures').then((d) => {
      const vs = d.ventures || []; setVentures(vs); setVenture((c) => c || vs[0] || null);
    }).catch(() => setVentures([]));
  }, []);

  const load = useCallback(async () => {
    if (!venture) return;
    setLoading(true);
    try {
      const data = await apiGet<Company[]>(`/api/companies?accountId=${venture.account_id}&brandId=${venture.id}`);
      setRows(Array.isArray(data) ? data : []);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [venture]);
  useEffect(() => { load(); }, [load]);

  const openDetail = async (c: Company) => {
    setSelected(c);
    try {
      const deals = await apiGet<Deal[]>(`/api/deals?accountId=${c.account_id}`);
      setDealsFor((deals || []).filter((d) => d.company_id === c.id));
    } catch { setDealsFor([]); }
  };

  const save = async () => {
    if (!venture || !form.name.trim()) { notify('Company name is required', 'error'); return; }
    setSaving(true);
    try {
      await apiSend('/api/companies', 'POST', { account_id: venture.account_id, brand_id: venture.id, ...form });
      notify('Company added', 'success'); setAddOpen(false); setForm(empty); load();
    } catch (e: any) { notify(e.message || 'Failed', 'error'); } finally { setSaving(false); }
  };

  const remove = async (c: Company) => {
    if (!confirm(`Delete ${c.name}?`)) return;
    try { await apiSend(`/api/companies/${c.id}`, 'DELETE'); notify('Deleted', 'success'); load(); }
    catch (e: any) { notify(e.message || 'Failed', 'error'); }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Companies</h1>
          <p className="text-sm text-slate-500">Organizations behind your contacts and deals.</p>
        </div>
        <div className="flex items-center gap-3">
          <Dropdown value={venture?.id || ''} onChange={(e) => setVenture(ventures.find((v) => v.id === e.target.value) || null)}
            options={ventures.map((v) => ({ value: v.id, label: v.name }))} />
          <Button onClick={() => setAddOpen(true)}>+ Add Company</Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Domain</th><th className="px-4 py-3">Industry</th><th className="px-4 py-3">Location</th><th className="px-4 py-3"></th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">Loading…</td></tr>
              : rows.length === 0 ? <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">No companies yet. Import Apollo leads or add one.</td></tr>
              : rows.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => openDetail(c)}>
                  <td className="px-4 py-3 font-medium text-slate-900">{c.name}</td>
                  <td className="px-4 py-3 text-slate-500">{c.domain || '—'}</td>
                  <td className="px-4 py-3 text-slate-500">{c.industry || '—'}</td>
                  <td className="px-4 py-3 text-slate-500">{c.location || '—'}</td>
                  <td className="px-4 py-3 text-right"><Button variant="ghost" onClick={(e) => { e.stopPropagation(); remove(c); }}>Delete</Button></td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={addOpen} title="Add Company" onClose={() => setAddOpen(false)} onSubmit={save} submitLabel="Add" loading={saving}>
        <div className="space-y-3">
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input label="Domain" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} />
          <Input label="Industry" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} />
          <Input label="Website" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
          <Input label="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        </div>
      </Modal>

      {selected && (
        <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40" onClick={() => setSelected(null)}>
          <div className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between">
              <div><h2 className="text-xl font-bold text-slate-900">{selected.name}</h2><p className="text-sm text-slate-500">{selected.industry || '—'}</p></div>
              <button onClick={() => setSelected(null)} className="text-xl text-slate-400">✕</button>
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Domain</dt><dd>{selected.domain || '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Website</dt><dd className="max-w-[60%] truncate">{selected.website || '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Location</dt><dd>{selected.location || '—'}</dd></div>
            </dl>
            <h3 className="mt-6 mb-2 text-sm font-semibold text-slate-700">Deals ({dealsFor.length})</h3>
            {dealsFor.length === 0 ? <p className="text-sm text-slate-400">No deals linked.</p> :
              <ul className="space-y-2">{dealsFor.map((d) => (
                <li key={d.id} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  <div className="font-medium">{d.name}</div>
                  <div className="text-slate-500">{d.amount ? `$${d.amount}` : '—'} · {d.status}</div>
                </li>))}</ul>}
          </div>
        </div>
      )}
    </div>
  );
}

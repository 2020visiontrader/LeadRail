'use client';
import { useEffect, useState, useCallback } from 'react';
import Button from '@/components/Button';
import Modal from '@/components/Modal';
import Input from '@/components/Input';
import Dropdown from '@/components/Dropdown';
import Badge from '@/components/Badge';
import KPICard from '@/components/KPICard';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import { AdCampaign } from '@/lib/types';

const BRAND = 'rentahub';
const CHANNELS = ['meta', 'google', 'tiktok', 'linkedin', 'other'];

export default function CampaignsPage() {
  const { notify } = useToast();
  const [rows, setRows] = useState<AdCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', channel: 'meta', budget: '', start_date: '', end_date: '' });

  const load = useCallback(async () => {
    setLoading(true);
    const data = await apiGet<AdCampaign[]>(`/api/campaigns?brandId=${BRAND}`).catch(() => []);
    setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.name) { notify('Name required', 'error'); return; }
    setSaving(true);
    try {
      await apiSend('/api/campaigns', 'POST', { brand_id: BRAND, ...form, budget: Number(form.budget) || 0, start_date: form.start_date || null, end_date: form.end_date || null });
      notify('Campaign created');
      setOpen(false); setForm({ name: '', channel: 'meta', budget: '', start_date: '', end_date: '' });
      load();
    } catch (e: any) { notify(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  };

  const remove = async (c: AdCampaign) => {
    if (!confirm(`Delete ${c.name}?`)) return;
    try { await apiSend(`/api/campaigns/${c.id}`, 'DELETE'); notify('Deleted'); load(); }
    catch (e: any) { notify(e.message || 'Delete failed', 'error'); }
  };

  const totalBudget = rows.reduce((s, r) => s + (Number(r.budget) || 0), 0);
  const totalSpend = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Campaigns</h1>
          <p className="text-sm text-slate-500">Ad campaigns</p>
        </div>
        <Button onClick={() => setOpen(true)}>+ New Campaign</Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <KPICard label="Campaigns" value={rows.length} icon="🎯" />
        <KPICard label="Total Budget" value={`$${totalBudget.toLocaleString()}`} icon="💰" />
        <KPICard label="Total Spend" value={`$${totalSpend.toLocaleString()}`} icon="📈" />
      </div>

      {loading ? <LoadingSpinner /> : rows.length === 0 ? (
        <EmptyState icon="🎯" title="No campaigns yet" hint="Create your first ad campaign. Persists once Supabase is connected." action={<Button onClick={() => setOpen(true)}>New Campaign</Button>} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr><th className="p-3 text-left">Name</th><th className="p-3 text-left">Channel</th><th className="p-3 text-right">Budget</th><th className="p-3 text-left">Status</th><th className="p-3 text-right">Actions</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="p-3 font-medium">{c.name}</td>
                  <td className="p-3"><Badge tone="blue">{c.channel || '—'}</Badge></td>
                  <td className="p-3 text-right">${Number(c.budget).toLocaleString()}</td>
                  <td className="p-3"><Badge tone={c.status === 'active' ? 'green' : 'gray'}>{c.status}</Badge></td>
                  <td className="p-3 text-right"><button className="text-red-600 hover:underline" onClick={() => remove(c)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal isOpen={open} title="New Campaign" onClose={() => setOpen(false)} onSubmit={create} submitLabel="Create" loading={saving}>
        <div className="space-y-4">
          <Input label="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Dropdown label="Channel" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} options={CHANNELS.map((c) => ({ value: c, label: c }))} />
          <Input label="Budget ($)" type="number" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Start" type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            <Input label="End" type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
          </div>
        </div>
      </Modal>
    </div>
  );
}

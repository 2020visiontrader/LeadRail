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

interface Venture { id: string; name: string; account_id: string }
const CHANNELS = ['meta', 'google', 'tiktok', 'linkedin', 'other'];

export default function CampaignsPage() {
  const { notify } = useToast();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [venture, setVenture] = useState<Venture | null>(null);
  const [rows, setRows] = useState<AdCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', channel: 'meta', budget: '', start_date: '', end_date: '' });
  const [assetCampaign, setAssetCampaign] = useState<AdCampaign | null>(null);
  const [assets, setAssets] = useState<any[]>([]);
  const [assetUrl, setAssetUrl] = useState('');
  const [assetBusy, setAssetBusy] = useState(false);

  useEffect(() => {
    apiGet<{ ventures: Venture[] }>('/api/ventures')
      .then((d) => { const vs = d.ventures || []; setVentures(vs); setVenture((cur) => cur || vs[0] || null); })
      .catch(() => setVentures([]));
  }, []);

  const openAssets = async (c: AdCampaign) => {
    setAssetCampaign(c); setAssets([]);
    try { setAssets(await apiGet<any[]>(`/api/campaigns/${c.id}/assets`)); } catch { /* empty */ }
  };
  const addAsset = async () => {
    if (!assetUrl.trim() || !assetCampaign) return;
    setAssetBusy(true);
    try {
      await apiSend(`/api/campaigns/${assetCampaign.id}/assets`, 'POST', { account_id: (assetCampaign as any).account_id || '00000000-0000-0000-0000-0000000000b1', url: assetUrl.trim(), kind: 'image' });
      setAssetUrl(''); openAssets(assetCampaign);
    } catch (e: any) { notify(e.message || 'Add failed', 'error'); }
    finally { setAssetBusy(false); }
  };
  const analyzeAssets = async () => {
    if (!assetCampaign) return;
    setAssetBusy(true);
    try {
      const r = await apiSend<{ analyzed: number }>(`/api/campaigns/${assetCampaign.id}/assets/analyze`, 'POST');
      notify(`Analyzed ${r.analyzed} asset(s)`); openAssets(assetCampaign);
    } catch (e: any) { notify(e.message === 'not_configured' ? 'Connect Gemini to analyze' : e.message || 'Analyze failed', 'error'); }
    finally { setAssetBusy(false); }
  };

  const load = useCallback(async () => {
    if (!venture) return;
    setLoading(true);
    const data = await apiGet<AdCampaign[]>(`/api/campaigns?brandId=${venture.id}`).catch(() => []);
    setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  }, [venture]);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.name) { notify('Name required', 'error'); return; }
    setSaving(true);
    try {
      await apiSend('/api/campaigns', 'POST', { brand_id: venture?.id, ...form, budget: Number(form.budget) || 0, start_date: form.start_date || null, end_date: form.end_date || null });
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
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold">Campaigns</h1>
            <p className="text-sm text-slate-500">Ad campaigns</p>
          </div>
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
                  <td className="p-3 text-right">
                    <button className="mr-3 text-indigo-600 hover:underline" onClick={() => openAssets(c)}>Assets</button>
                    <button className="text-red-600 hover:underline" onClick={() => remove(c)}>Delete</button>
                  </td>
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

      <Modal isOpen={!!assetCampaign} title={`Assets — ${assetCampaign?.name || ''}`} onClose={() => setAssetCampaign(null)} submitLabel="Analyze with AI" onSubmit={analyzeAssets} loading={assetBusy}>
        <div className="space-y-4">
          <p className="text-xs text-slate-500">Static ad images only (no video generation yet). Add image URLs, then run AI QA to score composition, legibility, and ad-policy fit.</p>
          <div className="flex items-end gap-2">
            <div className="flex-1"><Input label="Image URL" placeholder="https://…" value={assetUrl} onChange={(e) => setAssetUrl(e.target.value)} /></div>
            <Button variant="secondary" loading={assetBusy} onClick={addAsset}>Add</Button>
          </div>
          <div className="max-h-64 space-y-2 overflow-auto">
            {assets.length === 0 && <p className="text-sm text-slate-400">No assets yet.</p>}
            {assets.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded border border-slate-200 bg-white p-2 text-sm">
                <span className="truncate max-w-[60%]">{a.url}</span>
                <div className="flex items-center gap-2">
                  {a.ai_analysis?.score !== undefined && <span className="text-xs text-slate-500">score {a.ai_analysis.score}</span>}
                  <Badge tone={a.status === 'approved' ? 'green' : a.status === 'rejected' ? 'red' : 'gray'}>{a.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}

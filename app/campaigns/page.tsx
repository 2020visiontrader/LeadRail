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
import ProgressStages from '@/components/ProgressStages';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import { AdCampaign } from '@/lib/types';

interface Venture { id: string; name: string; account_id: string }
const CHANNELS = ['meta', 'google', 'tiktok', 'linkedin', 'other'];
const META_OBJECTIVES = ['OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_AWARENESS'];

// Extends AdCampaign with Meta-ads fields the backend now returns; kept local
// since lib/types.ts is owned by another workstream.
interface MetaAdCampaign extends AdCampaign {
  meta_campaign_id?: string | null;
  meta_ad_account_id?: string | null;
  objective?: string | null;
  meta_status?: 'PAUSED' | 'ACTIVE' | 'ARCHIVED' | null;
  last_synced_at?: string | null;
}

interface MetaAdAccount { id: string; name: string; account_status?: number }

function metaStatusTone(status?: string | null): 'green' | 'amber' | 'gray' {
  if (status === 'ACTIVE') return 'green';
  if (status === 'PAUSED') return 'amber';
  return 'gray';
}

export default function CampaignsPage() {
  const { notify } = useToast();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [venture, setVenture] = useState<Venture | null>(null);
  const [rows, setRows] = useState<MetaAdCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', channel: 'meta', budget: '', start_date: '', end_date: '', meta_ad_account_id: '', objective: 'OUTCOME_TRAFFIC' });
  const [assetCampaign, setAssetCampaign] = useState<AdCampaign | null>(null);
  const [assets, setAssets] = useState<any[]>([]);
  const [assetUrl, setAssetUrl] = useState('');
  const [assetBusy, setAssetBusy] = useState(false);
  const [metaAccounts, setMetaAccounts] = useState<MetaAdAccount[]>([]);
  const [metaAccountsLoaded, setMetaAccountsLoaded] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [abCampaign, setAbCampaign] = useState<MetaAdCampaign | null>(null);
  const [abReport, setAbReport] = useState<any>(null);
  const [abLoading, setAbLoading] = useState(false);
  const [abError, setAbError] = useState<string>('');

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
    } catch (e: any) { notify(e.message === 'not_configured' ? 'LeadRail AI is temporarily unavailable' : e.message || 'Analyze failed', 'error'); }
    finally { setAssetBusy(false); }
  };

  const load = useCallback(async () => {
    if (!venture) return;
    setLoading(true);
    const data = await apiGet<MetaAdCampaign[]>(`/api/campaigns?brandId=${venture.id}`).catch(() => []);
    setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  }, [venture]);
  useEffect(() => { load(); }, [load]);

  // Fetch connected Meta ad accounts once, the first time the create form's
  // channel is set to 'meta' (covers both the mount-with-meta-default case
  // and switching into it later).
  useEffect(() => {
    if (form.channel !== 'meta' || metaAccountsLoaded) return;
    setMetaAccountsLoaded(true);
    apiGet<{ accounts: MetaAdAccount[]; error?: string }>('/api/campaigns/meta/ad-accounts')
      .then((d) => setMetaAccounts(d.accounts || []))
      .catch(() => setMetaAccounts([]));
  }, [form.channel, metaAccountsLoaded]);

  const create = async () => {
    if (!form.name) { notify('Name required', 'error'); return; }
    setSaving(true);
    try {
      const isMeta = form.channel === 'meta';
      const { meta_ad_account_id, objective, ...rest } = form;
      const body: Record<string, unknown> = { brand_id: venture?.id, ...rest, budget: Number(form.budget) || 0, start_date: form.start_date || null, end_date: form.end_date || null };
      if (isMeta && meta_ad_account_id) { body.meta_ad_account_id = meta_ad_account_id; body.objective = objective; }
      await apiSend('/api/campaigns', 'POST', body);
      notify('Campaign created');
      setOpen(false); setForm({ name: '', channel: 'meta', budget: '', start_date: '', end_date: '', meta_ad_account_id: '', objective: 'OUTCOME_TRAFFIC' });
      load();
    } catch (e: any) { notify(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  };

  const remove = async (c: AdCampaign) => {
    if (!confirm(`Delete ${c.name}?`)) return;
    try { await apiSend(`/api/campaigns/${c.id}`, 'DELETE'); notify('Deleted'); load(); }
    catch (e: any) { notify(e.message || 'Delete failed', 'error'); }
  };

  const launchCampaign = async (c: MetaAdCampaign) => {
    if (!confirm('This activates a REAL Meta ad and will spend budget. Continue?')) return;
    setRowBusy(c.id);
    try {
      await apiSend(`/api/campaigns/${c.id}/launch`, 'POST', {});
      notify('Campaign launched on Meta');
      load();
    } catch (e: any) { notify(e.message || 'Launch failed', 'error'); }
    finally { setRowBusy(null); }
  };

  const pauseCampaign = async (c: MetaAdCampaign) => {
    setRowBusy(c.id);
    try {
      await apiSend(`/api/campaigns/${c.id}/pause`, 'POST', {});
      notify('Campaign paused');
      load();
    } catch (e: any) { notify(e.message || 'Pause failed', 'error'); }
    finally { setRowBusy(null); }
  };

  const syncCampaign = async (c: MetaAdCampaign) => {
    setRowBusy(c.id);
    try {
      const r = await apiGet<{ spend?: number }>(`/api/campaigns/${c.id}/sync`);
      notify(r && typeof r.spend === 'number' ? `Synced — spend $${r.spend.toLocaleString()}` : 'Synced');
      load();
    } catch (e: any) { notify(e.message || 'Sync failed', 'error'); }
    finally { setRowBusy(null); }
  };

  const openAb = async (c: MetaAdCampaign) => {
    setAbCampaign(c); setAbReport(null); setAbError(''); setAbLoading(true);
    try {
      setAbReport(await apiGet(`/api/campaigns/${c.id}/ab-test`));
    } catch (e: any) {
      setAbError(e?.message || 'Could not load analysis');
    } finally { setAbLoading(false); }
  };

  const totalBudget = rows.reduce((s, r) => s + (Number(r.budget) || 0), 0);
  const totalSpend = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">Campaigns</h1>
            <p className="text-sm text-[var(--text-secondary)]">Ad campaigns</p>
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
        <EmptyState icon="🎯" title="No campaigns yet" hint="Create your first ad campaign." action={<Button onClick={() => setOpen(true)}>New Campaign</Button>} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)]">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--border-default)] bg-[var(--bg-raised)] text-[var(--text-secondary)]">
              <tr><th className="p-3 text-left">Name</th><th className="p-3 text-left">Channel</th><th className="p-3 text-right">Budget</th><th className="p-3 text-left">Status</th><th className="p-3 text-right">Actions</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)] text-[var(--text-primary)]">
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-[var(--bg-raised)]">
                  <td className="p-3 font-medium">{c.name}</td>
                  <td className="p-3"><Badge tone="blue">{c.channel || '—'}</Badge></td>
                  <td className="p-3 text-right">${Number(c.budget).toLocaleString()}</td>
                  <td className="p-3">
                    <Badge tone={c.status === 'active' ? 'green' : 'gray'}>{c.status}</Badge>
                    {c.meta_campaign_id && (
                      <span className="ml-1.5 inline-block">
                        <Badge tone={metaStatusTone(c.meta_status)}>Meta: {c.meta_status || 'UNKNOWN'}</Badge>
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    {c.meta_campaign_id && c.meta_status !== 'ACTIVE' && (
                      <button
                        className="mr-3 text-[var(--status-positive)] hover:underline disabled:cursor-not-allowed disabled:text-[var(--text-muted)] disabled:no-underline"
                        disabled={!Number(c.budget) || rowBusy === c.id}
                        title={!Number(c.budget) ? 'Set a budget first' : undefined}
                        onClick={() => launchCampaign(c)}
                      >
                        Launch
                      </button>
                    )}
                    {c.meta_status === 'ACTIVE' && (
                      <button className="mr-3 text-[#D97706] hover:underline disabled:text-[var(--text-muted)]" disabled={rowBusy === c.id} onClick={() => pauseCampaign(c)}>Pause</button>
                    )}
                    {c.meta_campaign_id && (
                      <button className="mr-3 text-[var(--text-secondary)] hover:underline disabled:text-[var(--text-muted)]" disabled={rowBusy === c.id} onClick={() => syncCampaign(c)}>
                        {rowBusy === c.id ? 'Syncing…' : 'Sync'}
                      </button>
                    )}
                    {c.meta_campaign_id && (
                      <button className="mr-3 text-[var(--brand)] hover:underline" onClick={() => openAb(c)}>Analyze</button>
                    )}
                    <button className="mr-3 text-[var(--brand)] hover:underline" onClick={() => openAssets(c)}>Assets</button>
                    <button className="text-[var(--status-negative)] hover:underline" onClick={() => remove(c)}>Delete</button>
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
          {form.channel === 'meta' && (
            metaAccounts.length > 0 ? (
              <>
                <Dropdown
                  label="Meta Ad Account"
                  value={form.meta_ad_account_id}
                  onChange={(e) => setForm({ ...form, meta_ad_account_id: e.target.value })}
                  options={[{ value: '', label: 'Local only (no live ad account)' }, ...metaAccounts.map((a) => ({ value: a.id, label: a.name }))]}
                />
                {form.meta_ad_account_id && (
                  <Dropdown
                    label="Objective"
                    value={form.objective}
                    onChange={(e) => setForm({ ...form, objective: e.target.value })}
                    options={META_OBJECTIVES.map((o) => ({ value: o, label: o }))}
                  />
                )}
              </>
            ) : (
              <p className="text-xs text-[var(--text-secondary)]">Connect a Meta ad account to launch live ads.</p>
            )
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Start" type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            <Input label="End" type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!abCampaign} title={`A/B Analysis — ${abCampaign?.name || ''}`} onClose={() => setAbCampaign(null)} maxWidth="max-w-3xl">
        {abLoading ? (
          <ProgressStages active stages={['Pulling live ad performance…', 'Comparing creatives…', 'Finding the winner…', 'Writing your recommendation…']} />
        ) : abError ? (
          <p className="text-sm text-[var(--status-negative)]">{abError}</p>
        ) : abReport ? (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-3">
              <KPICard label="Spend" value={`$${(abReport.totals.spend || 0).toFixed(2)}`} />
              <KPICard label="Impressions" value={(abReport.totals.impressions || 0).toLocaleString()} />
              <KPICard label="Avg CTR" value={`${(abReport.totals.ctr || 0).toFixed(2)}%`} />
              <KPICard label="Results" value={abReport.totals.conversions || 0} />
            </div>

            <div className="rounded-xl border border-[var(--brand)] bg-[color-mix(in_srgb,var(--brand)_8%,transparent)] p-4">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Recommendation</div>
              <p className="text-sm text-[var(--text-primary)]">{abReport.recommendation}</p>
            </div>

            {abReport.variants.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">No delivery data yet. Launch the campaign and check back once ads start spending.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-[var(--border-default)]">
                <table className="w-full text-sm">
                  <thead className="border-b border-[var(--border-default)] bg-[var(--bg-raised)] text-[var(--text-secondary)]">
                    <tr>
                      <th className="p-2.5 text-left">Creative</th>
                      <th className="p-2.5 text-right">Spend</th>
                      <th className="p-2.5 text-right">Impr.</th>
                      <th className="p-2.5 text-right">CTR</th>
                      <th className="p-2.5 text-right">CPC</th>
                      <th className="p-2.5 text-right">Results</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-default)] text-[var(--text-primary)]">
                    {abReport.variants.map((v: any) => {
                      const isWinner = abReport.winner && v.objectId === abReport.winner.objectId;
                      return (
                        <tr key={v.objectId} className={isWinner ? 'bg-[color-mix(in_srgb,var(--status-positive)_10%,transparent)]' : ''}>
                          <td className="p-2.5 font-medium">
                            {v.name}{isWinner && <span className="ml-2"><Badge tone="green">Winner</Badge></span>}
                          </td>
                          <td className="p-2.5 text-right">${v.spend.toFixed(2)}</td>
                          <td className="p-2.5 text-right">{v.impressions.toLocaleString()}</td>
                          <td className="p-2.5 text-right">{v.ctr.toFixed(2)}%</td>
                          <td className="p-2.5 text-right">${v.cpc.toFixed(2)}</td>
                          <td className="p-2.5 text-right">{v.conversions}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </Modal>

      <Modal isOpen={!!assetCampaign} title={`Assets — ${assetCampaign?.name || ''}`} onClose={() => setAssetCampaign(null)} submitLabel="Analyze with AI" onSubmit={analyzeAssets} loading={assetBusy}>
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-secondary)]">Static ad images only (no video generation yet). Add image URLs, then run AI QA to score composition, legibility, and ad-policy fit.</p>
          <div className="flex items-end gap-2">
            <div className="flex-1"><Input label="Image URL" placeholder="https://…" value={assetUrl} onChange={(e) => setAssetUrl(e.target.value)} /></div>
            <Button variant="secondary" loading={assetBusy} onClick={addAsset}>Add</Button>
          </div>
          <div className="max-h-64 space-y-2 overflow-auto">
            {assets.length === 0 && <p className="text-sm text-[var(--text-muted)]">No assets yet.</p>}
            {assets.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded border border-[var(--border-default)] bg-[var(--bg-surface)] p-2 text-sm">
                <span className="truncate max-w-[60%]">{a.url}</span>
                <div className="flex items-center gap-2">
                  {a.ai_analysis?.score !== undefined && <span className="text-xs text-[var(--text-secondary)]">score {a.ai_analysis.score}</span>}
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

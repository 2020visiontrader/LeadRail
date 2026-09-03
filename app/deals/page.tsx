'use client';
import { useState, useEffect, useCallback } from 'react';
import Modal from '@/components/Modal';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Dropdown from '@/components/Dropdown';
import Badge from '@/components/Badge';
import EmptyState from '@/components/EmptyState';
import CommandBar from '@/components/CommandBar';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import type { Deal, PipelineStage, Company } from '@/lib/types';

interface Venture { id: string; name: string; account_id: string }
const empty = { name: '', amount: '', company_id: '', stage_id: '' };

// Deterministic stage identity color (hue from name). This is stage IDENTITY,
// not a lead/deal status remap — deal status pills still use the fixed map below.
function stageHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}
// Won/lost columns override to the semantic status colors.
function stageColor(stage: PipelineStage): string {
  if (stage.is_won) return 'var(--status-positive)';
  if (stage.is_lost) return 'var(--status-negative)';
  return `hsl(${stageHue(stage.name)} 65% 58%)`;
}
// Deal status -> Badge tone (fixed): won=positive, lost=negative, open=active.
function dealTone(status: string): 'green' | 'red' | 'blue' {
  return status === 'won' ? 'green' : status === 'lost' ? 'red' : 'blue';
}
const money = (n?: number, currency = 'USD') =>
  typeof n === 'number' && n > 0
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
    : '—';
const initials = (s: string) => (s.trim()[0] || '?').toUpperCase();

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
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  // Which deal cards are checked — the turn-context proof for this page (see
  // lib/agent/turn-context.ts and app/leads/page.tsx's matching comment).
  // A plain checkbox, not a click-to-select on the card itself, because the
  // whole card is already a drag handle — overloading its click would fight
  // dragging and the existing ◀▶ stage buttons.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelected = (id: string) =>
    setSelectedIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

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

  // Move a deal to an arbitrary stage (drag-drop or ◀▶). Optimistic, then PATCH.
  const moveTo = async (deal: Deal, stageId: string) => {
    if (!stageId || stageId === deal.stage_id) return;
    setDeals((ds) => ds.map((d) => (d.id === deal.id ? { ...d, stage_id: stageId } : d)));
    try { await apiSend(`/api/deals/${deal.id}/stage`, 'PATCH', { stage_id: stageId }); }
    catch (e: any) { notify(e.message || 'Move failed', 'error'); load(); }
  };
  const step = (deal: Deal, dir: -1 | 1) => {
    const idx = ordered.findIndex((s) => s.id === deal.stage_id);
    const next = ordered[idx + dir];
    if (next) moveTo(deal, next.id);
  };

  const ordered = [...stages].sort((a, b) => a.position - b.position);
  const companyName = (id?: string) => companies.find((c) => c.id === id)?.name;
  const totalOpen = deals.filter((d) => d.status === 'open').reduce((n, d) => n + (Number(d.amount) || 0), 0);

  return (
    <div className="mx-auto max-w-full space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Pipeline</h1>
          <p className="text-sm text-[var(--text-muted)]">
            {deals.length} deal{deals.length === 1 ? '' : 's'} · {money(totalOpen)} open · drag a card between stages
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Dropdown value={venture?.id || ''} onChange={(e) => setVenture(ventures.find((v) => v.id === e.target.value) || null)}
            options={ventures.map((v) => ({ value: v.id, label: v.name }))} />
          <Button onClick={() => setAddOpen(true)}>+ Add Deal</Button>
        </div>
      </div>

      {loading ? (
        <p className="text-[var(--text-muted)]">Loading…</p>
      ) : ordered.length === 0 ? (
        <EmptyState icon="📊" title="No pipeline stages" hint="Configure pipeline stages for this brand to start tracking deals." />
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {ordered.map((stage) => {
            const col = deals.filter((d) => d.stage_id === stage.id);
            const sum = col.reduce((n, d) => n + (Number(d.amount) || 0), 0);
            const color = stageColor(stage);
            const isOver = overStage === stage.id;
            return (
              <div
                key={stage.id}
                onDragOver={(e) => { e.preventDefault(); if (dragId) setOverStage(stage.id); }}
                onDragLeave={() => setOverStage((s) => (s === stage.id ? null : s))}
                onDrop={() => {
                  const d = deals.find((x) => x.id === dragId);
                  if (d) moveTo(d, stage.id);
                  setDragId(null); setOverStage(null);
                }}
                className={`flex w-72 shrink-0 flex-col rounded-xl border bg-[var(--bg-raised)] p-3 transition-colors ${
                  isOver ? 'border-[var(--brand)] bg-[var(--brand-soft)]' : 'border-[var(--border-default)]'
                }`}
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                    <span className="size-2.5 rounded-full" style={{ background: color }} />
                    {stage.name}
                  </span>
                  <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">
                    {col.length} · {money(sum)}
                  </span>
                </div>
                <div className="flex-1 space-y-2">
                  {col.map((d) => (
                    <div
                      key={d.id}
                      draggable
                      onDragStart={() => setDragId(d.id)}
                      onDragEnd={() => { setDragId(null); setOverStage(null); }}
                      className={`cursor-grab rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 shadow-sm transition active:cursor-grabbing ${
                        dragId === d.id ? 'opacity-40' : 'hover:border-[var(--border-strong)]'
                      }`}
                      style={{ borderLeft: `3px solid ${color}` }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-start gap-1.5">
                          <input
                            type="checkbox"
                            className="mt-0.5 shrink-0"
                            checked={selectedIds.has(d.id)}
                            onChange={() => toggleSelected(d.id)}
                            onClick={(e) => e.stopPropagation()}
                            title="Select for Ask LeadRail AI"
                          />
                          <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-[var(--text-primary)]">{d.name}</div>
                          <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                            {d.company_id && (
                              <span
                                className="flex size-4 items-center justify-center rounded-full text-[8px] font-bold"
                                style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }}
                                aria-hidden
                              >
                                {initials(companyName(d.company_id) || '?')}
                              </span>
                            )}
                            <span className="truncate">{companyName(d.company_id) || 'No company'}</span>
                          </div>
                          </div>
                        </div>
                        <span className="shrink-0 text-sm font-semibold text-[var(--text-primary)]">{money(d.amount, d.currency)}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <button
                          onClick={() => step(d, -1)}
                          className="text-[var(--text-muted)] hover:text-[var(--brand)] disabled:opacity-30"
                          disabled={ordered.findIndex((s) => s.id === d.stage_id) <= 0}
                          title="Move back"
                        >◀</button>
                        <Badge tone={dealTone(d.status)}>{d.status}</Badge>
                        <button
                          onClick={() => step(d, 1)}
                          className="text-[var(--text-muted)] hover:text-[var(--brand)] disabled:opacity-30"
                          disabled={ordered.findIndex((s) => s.id === d.stage_id) >= ordered.length - 1}
                          title="Move forward"
                        >▶</button>
                      </div>
                    </div>
                  ))}
                  {col.length === 0 && (
                    <div className="rounded-lg border border-dashed border-[var(--border-default)] py-6 text-center text-xs text-[var(--text-muted)]">
                      {isOver ? 'Drop here' : 'Empty'}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* PROOF OF THE TURN-CONTEXT PATTERN — see the matching comment on
          app/leads/page.tsx. Same CommandBar, this screen's own state:
          venture, the checked deal cards, and (once this page grows a filter
          UI) whatever it filters by. */}
      <CommandBar brandId={venture?.id} page="deals" selectedIds={[...selectedIds]} />

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

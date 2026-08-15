'use client';

import { useCallback, useEffect, useState } from 'react';
import Button from '@/components/Button';
import Badge from '@/components/Badge';
import Input from '@/components/Input';
import Dropdown from '@/components/Dropdown';
import Modal from '@/components/Modal';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';

// Settings-adjacent CRM feature: dynamic contact segments (migration
// 030_segments.sql). A segment is a saved filter over contacts — built from a
// whitelisted set of fields/ops (see lib/segments/store.ts) so it can be
// safely translated into a query with no raw SQL. This UI can add/remove
// filter rows and preview the live match count before saving.

const FIELDS = [
  'name', 'email', 'company', 'title', 'segment', 'status',
  'source', 'enrichment_status', 'fit_verdict', 'score', 'created_at',
] as const;
type Field = (typeof FIELDS)[number];

const OPS: { key: string; label: string; needsValue: boolean }[] = [
  { key: 'eq', label: 'is', needsValue: true },
  { key: 'neq', label: 'is not', needsValue: true },
  { key: 'contains', label: 'contains', needsValue: true },
  { key: 'gt', label: '>', needsValue: true },
  { key: 'lt', label: '<', needsValue: true },
  { key: 'is_null', label: 'is empty', needsValue: false },
  { key: 'not_null', label: 'is not empty', needsValue: false },
];

interface FilterRow { field: Field; op: string; value: string }
interface Segment {
  id: string;
  name: string;
  description: string | null;
  filters: FilterRow[];
  created_at: string;
  updated_at: string;
}

const EMPTY_FILTER: FilterRow = { field: 'status', op: 'eq', value: '' };

function opNeedsValue(op: string): boolean {
  return OPS.find((o) => o.key === op)?.needsValue ?? true;
}

export default function Segments() {
  const { notify } = useToast();
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [filters, setFilters] = useState<FilterRow[]>([{ ...EMPTY_FILTER }]);
  const [saving, setSaving] = useState(false);

  const [preview, setPreview] = useState<{ count: number; sample: any[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ segments: Segment[] }>('/api/segments');
      setSegments(res.segments || []);
    } catch (e: any) {
      notify(e?.message || 'Failed to load segments', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setEditingId(null);
    setName('');
    setDescription('');
    setFilters([{ ...EMPTY_FILTER }]);
    setPreview(null);
    setModalOpen(true);
  }

  function openEdit(s: Segment) {
    setEditingId(s.id);
    setName(s.name);
    setDescription(s.description || '');
    setFilters(s.filters?.length ? JSON.parse(JSON.stringify(s.filters)) : [{ ...EMPTY_FILTER }]);
    setPreview(null);
    setModalOpen(true);
  }

  function addFilterRow() {
    setFilters((prev) => [...prev, { ...EMPTY_FILTER }]);
  }

  function removeFilterRow(idx: number) {
    setFilters((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateFilterRow(idx: number, patch: Partial<FilterRow>) {
    setFilters((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  }

  function cleanFilters(): FilterRow[] {
    return filters
      .filter((f) => f.field && f.op)
      .map((f) => (opNeedsValue(f.op) ? f : { ...f, value: '' }))
      .filter((f) => !opNeedsValue(f.op) || f.value !== '');
  }

  async function runPreview() {
    const clean = cleanFilters();
    setPreviewing(true);
    try {
      const res = await apiSend<{ count: number; sample: any[] }>('/api/segments/preview', 'POST', { filters: clean });
      setPreview(res);
    } catch (e: any) {
      notify(e?.message || 'Preview failed', 'error');
    } finally {
      setPreviewing(false);
    }
  }

  async function save() {
    const n = name.trim();
    if (!n) { notify('Name is required', 'error'); return; }
    const clean = cleanFilters();
    setSaving(true);
    try {
      if (editingId) {
        await apiSend(`/api/segments/${editingId}`, 'PATCH', { name: n, description: description.trim() || null, filters: clean });
      } else {
        await apiSend('/api/segments', 'POST', { name: n, description: description.trim() || undefined, filters: clean });
      }
      notify('Segment saved', 'success');
      setModalOpen(false);
      await load();
    } catch (e: any) {
      notify(e?.message || 'Failed to save segment', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function remove(s: Segment) {
    if (!confirm(`Delete segment "${s.name}"?`)) return;
    try {
      await apiSend(`/api/segments/${s.id}`, 'DELETE');
      await load();
    } catch (e: any) {
      notify(e?.message || 'Failed to delete', 'error');
    }
  }

  const fieldOptions = FIELDS.map((f) => ({ value: f, label: f }));
  const opOptions = OPS.map((o) => ({ value: o.key, label: o.label }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">Segments</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Dynamic, re-runnable filters over your contacts. Build a filter from whitelisted fields, preview the
            match count, then save it as a segment.
          </p>
        </div>
        <Button className="shrink-0" onClick={openCreate}>+ New segment</Button>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : segments.length === 0 ? (
        <EmptyState title="No segments yet" hint="Create your first dynamic segment above." />
      ) : (
        <div className="space-y-3">
          {segments.map((s) => (
            <div key={s.id} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--text-primary)]">{s.name}</span>
                    <Badge tone="gray">{(s.filters || []).length} filter{(s.filters || []).length === 1 ? '' : 's'}</Badge>
                  </div>
                  {s.description && <p className="mt-1 text-xs text-[var(--text-muted)]">{s.description}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => openEdit(s)}>Edit</Button>
                  <Button variant="danger" onClick={() => remove(s)}>Delete</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        title={editingId ? 'Edit segment' : 'New segment'}
        onClose={() => setModalOpen(false)}
        onSubmit={save}
        submitLabel={saving ? 'Saving…' : 'Save segment'}
        loading={saving}
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Name" placeholder="e.g. Hot Bali leads" value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="Description (optional)" placeholder="One line describing this segment" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--text-secondary)]">Filters</span>
              <button className="text-xs text-[var(--brand)]" onClick={addFilterRow}>+ add filter</button>
            </div>
            <div className="space-y-2">
              {filters.map((f, idx) => (
                <div key={idx} className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border-default)] p-2">
                  <Dropdown
                    className="w-40"
                    options={fieldOptions}
                    value={f.field}
                    onChange={(e) => updateFilterRow(idx, { field: (e.target as HTMLSelectElement).value as Field })}
                  />
                  <Dropdown
                    className="w-36"
                    options={opOptions}
                    value={f.op}
                    onChange={(e) => updateFilterRow(idx, { op: (e.target as HTMLSelectElement).value })}
                  />
                  {opNeedsValue(f.op) && (
                    <Input
                      className="grow"
                      placeholder="value"
                      value={f.value}
                      onChange={(e) => updateFilterRow(idx, { value: e.target.value })}
                    />
                  )}
                  <button className="text-xs text-[var(--status-negative)]" onClick={() => removeFilterRow(idx)}>remove</button>
                </div>
              ))}
              {filters.length === 0 && (
                <p className="text-xs text-[var(--text-muted)]">No filters — this segment will match every contact.</p>
              )}
            </div>
          </div>

          <div>
            <Button variant="secondary" onClick={runPreview} disabled={previewing}>
              {previewing ? 'Previewing…' : 'Preview'}
            </Button>
            {preview && (
              <div className="mt-3 rounded-md border border-[var(--border-default)] bg-[var(--bg-raised)] p-3">
                <p className="text-sm font-medium text-[var(--text-primary)]">{preview.count} matching contact{preview.count === 1 ? '' : 's'}</p>
                {preview.sample.length > 0 && (
                  <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-xs text-[var(--text-secondary)]">
                    {preview.sample.map((c: any) => (
                      <li key={c.id} className="truncate">
                        {c.name || c.email || c.id} {c.company ? `· ${c.company}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}

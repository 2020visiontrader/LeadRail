'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import Badge from '@/components/Badge';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Textarea from '@/components/Textarea';
import Dropdown from '@/components/Dropdown';
import Modal from '@/components/Modal';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { apiGet, apiSend } from '@/lib/api';

// Settings -> Skills. Catalog browser for the skills catalog (migration
// 025_skills.sql): the built-in 12 (read-only, informational) plus the
// harvested OSS catalog and this account's own custom skills, with per-account
// enable/disable + instructions override. Entirely optional: with nothing
// enabled here, LeadRail AI's agent loop behaves exactly as it does today
// (see lib/agent/loop.ts skillsBlock).

interface CatalogSkill {
  id: string;
  slug?: string;
  name: string;
  description: string | null;
  category: string | null;
  instructions: string;
  source: string | null;
  license: string | null;
  inspiredBy: string | null;
  qualityFlags: string[];
  isCustom: boolean;
  enabled: boolean;
  overriddenInstructions: string | null;
}

const EMPTY_DRAFT = { name: '', description: '', category: '', instructions: '' };
type Draft = typeof EMPTY_DRAFT;

export default function Skills() {
  const [catalog, setCatalog] = useState<CatalogSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');

  const [viewing, setViewing] = useState<CatalogSkill | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ catalog: CatalogSkill[] }>('/api/skills');
      setCatalog(res.catalog || []);
    } catch {
      /* surfaced via empty state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const categories = useMemo(
    () => Array.from(new Set(catalog.map((s) => s.category).filter(Boolean))) as string[],
    [catalog],
  );
  const sources = useMemo(
    () => Array.from(new Set(catalog.map((s) => s.source).filter(Boolean))) as string[],
    [catalog],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((s) => {
      if (categoryFilter && s.category !== categoryFilter) return false;
      if (sourceFilter && s.source !== sourceFilter) return false;
      if (q && !`${s.name} ${s.description || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [catalog, search, categoryFilter, sourceFilter]);

  // Pagination. The catalog is 353 skills; rendering them as one column meant
  // scrolling hundreds of rows to reach anything and losing your place on every
  // filter change. Page size is the user's choice — some want a quick scan, some
  // want to page through deliberately.
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  // Any filter/search/page-size change invalidates the current page number —
  // without this you can end up on page 12 of a 2-page result and see nothing.
  useEffect(() => { setPage(1); }, [search, categoryFilter, sourceFilter, pageSize]);
  const pageStart = (page - 1) * pageSize;
  const visible = filtered.slice(pageStart, pageStart + pageSize);

  function openCreate() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFormErr(null);
    setModalOpen(true);
  }

  function openEdit(s: CatalogSkill) {
    setEditingId(s.id);
    setDraft({
      name: s.name,
      description: s.description || '',
      category: s.category || '',
      instructions: s.instructions,
    });
    setFormErr(null);
    setModalOpen(true);
  }

  async function submit() {
    if (!draft.name.trim()) { setFormErr('Name is required'); return; }
    if (!draft.instructions.trim()) { setFormErr('Instructions is required'); return; }
    setSaving(true);
    setFormErr(null);
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      category: draft.category.trim() || null,
      instructions: draft.instructions,
    };
    try {
      if (editingId) {
        await apiSend(`/api/skills/${editingId}`, 'PATCH', payload);
      } else {
        await apiSend('/api/skills', 'POST', payload);
      }
      setModalOpen(false);
      await load();
    } catch (e: any) {
      setFormErr(e?.message || 'Could not save skill');
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(s: CatalogSkill) {
    try {
      await apiSend(`/api/skills/${s.id}`, 'PATCH', { enabled: !s.enabled });
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not update skill' });
    }
  }

  async function removeSkill(s: CatalogSkill) {
    try {
      await apiSend(`/api/skills/${s.id}`, 'DELETE');
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not remove skill' });
    }
  }

  const categoryOptions = [{ value: '', label: 'All categories' }, ...categories.map((c) => ({ value: c, label: c }))];
  const sourceOptions = [{ value: '', label: 'All sources' }, ...sources.map((s) => ({ value: s, label: s }))];

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Skills</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            Optional catalog of prompt-module skills LeadRail AI can draw on — built-in, harvested from open-source
            SKILL.md packs, or your own custom ones. Enable a skill to fold its instructions into the agent's
            guidance. With nothing enabled, LeadRail AI behaves exactly as it does today.
          </p>
        </div>
        <Button variant="secondary" className="shrink-0 text-xs" onClick={openCreate}>+ Add custom skill</Button>
      </div>

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Input placeholder="Search skills…" value={search} onChange={(e) => setSearch((e.target as HTMLInputElement).value)} />
        <Dropdown options={categoryOptions} value={categoryFilter} onChange={(e) => setCategoryFilter((e.target as HTMLSelectElement).value)} />
        <Dropdown options={sourceOptions} value={sourceFilter} onChange={(e) => setSourceFilter((e.target as HTMLSelectElement).value)} />
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="🧩"
          title={catalog.length === 0 ? 'No skills catalog available yet' : 'No skills match your filters'}
          hint={catalog.length === 0 ? 'The skills catalog needs the database configured to load harvested and custom skills.' : undefined}
        />
      ) : (
        <div className="space-y-2">
          {visible.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{s.name}</span>
                  {s.category && <Badge tone="gray">{s.category}</Badge>}
                  {s.isCustom ? <Badge tone="indigo">custom</Badge> : <Badge tone="blue">{s.source || 'built-in'}</Badge>}
                  <Badge tone={s.enabled ? 'green' : 'gray'}>{s.enabled ? 'enabled' : 'disabled'}</Badge>
                  {s.license && <Badge tone="gray">{s.license}</Badge>}
                  {(s.qualityFlags || []).map((f) => (
                    <Badge key={f} tone="amber">{f}</Badge>
                  ))}
                </div>
                {s.description && <p className="mt-1 truncate text-xs text-[var(--text-muted)]">{s.description}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" className="text-xs" onClick={() => setViewing(s)}>View</Button>
                {s.isCustom && <Button variant="ghost" className="text-xs" onClick={() => openEdit(s)}>Edit</Button>}
                <Button variant="ghost" className="text-xs" onClick={() => toggleEnabled(s)}>{s.enabled ? 'Disable' : 'Enable'}</Button>
                {s.isCustom && <Button variant="danger" className="text-xs" onClick={() => removeSkill(s)}>Remove</Button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pager. Rendered whenever there is more than one page, or whenever the
          result set is large enough that the page-size choice matters. */}
      {filtered.length > 0 && (filtered.length > pageSize || pageSize !== 10) && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
            <span>
              {pageStart + 1}&ndash;{Math.min(pageStart + pageSize, filtered.length)} of {filtered.length}
            </span>
            <label className="flex items-center gap-1.5">
              <span className="sr-only">Skills per page</span>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[13px] text-[var(--text-primary)]"
              >
                {[10, 20, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
              </select>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              &larr; Previous
            </Button>
            <span className="text-[13px] text-[var(--text-secondary)]">Page {page} of {pageCount}</span>
            <Button variant="secondary" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}>
              Next &rarr;
            </Button>
          </div>
        </div>
      )}

      {/* View instructions */}
      <Modal
        isOpen={Boolean(viewing)}
        title={viewing?.name || 'Skill'}
        onClose={() => setViewing(null)}
      >
        {viewing && (
          <div className="space-y-3">
            {viewing.description && <p className="text-sm text-[var(--text-secondary)]">{viewing.description}</p>}
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border-default)] bg-[var(--bg-canvas)] p-3 text-xs text-[var(--text-primary)]">
              {viewing.overriddenInstructions || viewing.instructions}
            </pre>
            {viewing.inspiredBy && <p className="text-xs text-[var(--text-muted)]">Source: {viewing.inspiredBy}</p>}
          </div>
        )}
      </Modal>

      {/* Create / edit custom skill */}
      <Modal
        isOpen={modalOpen}
        title={editingId ? 'Edit custom skill' : 'Add custom skill'}
        onClose={() => setModalOpen(false)}
        onSubmit={submit}
        submitLabel={editingId ? 'Save' : 'Create'}
        loading={saving}
        maxWidth="max-w-xl"
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Name" placeholder="e.g. Renewal Copy Specialist" value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: (e.target as HTMLInputElement).value }))} />
            <Input label="Category (optional)" placeholder="e.g. outreach" value={draft.category}
              onChange={(e) => setDraft((d) => ({ ...d, category: (e.target as HTMLInputElement).value }))} />
          </div>
          <Input label="Description (optional)" placeholder="One line: when should this skill apply?" value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: (e.target as HTMLInputElement).value }))} />
          <Textarea label="Instructions" placeholder="The system-prompt guidance this skill contributes…" rows={6}
            value={draft.instructions}
            onChange={(e) => setDraft((d) => ({ ...d, instructions: (e.target as HTMLTextAreaElement).value }))} />
          {formErr && <p className="text-xs text-red-600">{formErr}</p>}
        </div>
      </Modal>
    </div>
  );
}

'use client';
import { useEffect, useState, useCallback } from 'react';
import Badge from '@/components/Badge';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Textarea from '@/components/Textarea';
import Dropdown from '@/components/Dropdown';
import Checkbox from '@/components/Checkbox';
import Modal from '@/components/Modal';
import LoadingSpinner from '@/components/LoadingSpinner';
import { apiGet, apiSend } from '@/lib/api';

// Settings -> Personas. CRUD for the account's agent persona roster
// (migration 024_personas.sql) that lib/agent/loop.ts can route to via
// personaId or @mention. Entirely optional: with zero personas here, the
// agent keeps using its single default LeadRail AI system prompt, unchanged.

interface Persona {
  id: string;
  name: string;
  role: string | null;
  instructions: string;
  model_id: string | null;
  tone: string | null;
  avatar: string | null;
  is_coordinator: boolean;
  enabled: boolean;
  sort_order: number;
}

interface Provider {
  id: string;
  name: string;
  kind: string;
}

interface ModelOption {
  id: string;
  label: string;
}

const EMPTY_DRAFT = {
  name: '',
  role: '',
  instructions: '',
  model_id: '',
  tone: '',
  is_coordinator: false,
};

type Draft = typeof EMPTY_DRAFT;

function toDraft(p: Persona): Draft {
  return {
    name: p.name,
    role: p.role || '',
    instructions: p.instructions || '',
    model_id: p.model_id || '',
    tone: p.tone || '',
    is_coordinator: p.is_coordinator,
  };
}

export default function Personas() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [personasRes, providersRes] = await Promise.all([
        apiGet<{ personas: Persona[] }>('/api/personas'),
        apiGet<{ providers: Provider[] }>('/api/ai/providers'),
      ]);
      setPersonas(personasRes.personas || []);
      const modelLists = await Promise.all(
        (providersRes.providers || []).map((p) =>
          apiGet<{ models: { id: string; model_id: string; label: string | null }[] }>(`/api/ai/providers/${p.id}/models`)
            .then((r) => (r.models || []).map((m) => ({ id: m.id, label: `${m.label || m.model_id} (${p.name})` })))
            .catch(() => []),
        ),
      );
      setModels(modelLists.flat());
    } catch {
      /* surfaced via empty state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const modelOptions = [{ value: '', label: 'Account default routing' }, ...models.map((m) => ({ value: m.id, label: m.label }))];

  function openCreate() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFormErr(null);
    setModalOpen(true);
  }

  function openEdit(p: Persona) {
    setEditingId(p.id);
    setDraft(toDraft(p));
    setFormErr(null);
    setModalOpen(true);
  }

  async function submit() {
    if (!draft.name.trim()) { setFormErr('Name is required'); return; }
    setSaving(true);
    setFormErr(null);
    const payload = {
      name: draft.name.trim(),
      role: draft.role.trim() || null,
      instructions: draft.instructions,
      model_id: draft.model_id || null,
      tone: draft.tone.trim() || null,
      is_coordinator: draft.is_coordinator,
    };
    try {
      if (editingId) {
        await apiSend(`/api/personas/${editingId}`, 'PATCH', payload);
      } else {
        await apiSend('/api/personas', 'POST', payload);
      }
      setModalOpen(false);
      await load();
    } catch (e: any) {
      setFormErr(e?.message || 'Could not save persona');
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(p: Persona) {
    try {
      await apiSend(`/api/personas/${p.id}`, 'PATCH', { enabled: !p.enabled });
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not update persona' });
    }
  }

  async function removePersona(p: Persona) {
    try {
      await apiSend(`/api/personas/${p.id}`, 'DELETE');
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not remove persona' });
    }
  }

  const modelLabel = (id: string | null) => (id ? models.find((m) => m.id === id)?.label || 'Custom model' : 'Account default');

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Personas</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            Optional: give LeadRail AI a roster of named personas — each with its own instructions, tone, and model.
            Mention one with @name in a chat, or pick a coordinator to synthesize replies when several are mentioned.
            With no personas here, LeadRail AI behaves exactly as it does today.
          </p>
        </div>
        <Button variant="secondary" className="shrink-0 text-xs" onClick={openCreate}>+ Add persona</Button>
      </div>

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : personas.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No personas configured — LeadRail AI is using its single default system prompt.</p>
      ) : (
        <div className="space-y-2">
          {personas.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{p.name}</span>
                  {p.role && <span className="text-xs text-[var(--text-muted)]">{p.role}</span>}
                  {p.is_coordinator && <Badge tone="indigo">coordinator</Badge>}
                  <Badge tone={p.enabled ? 'green' : 'gray'}>{p.enabled ? 'enabled' : 'disabled'}</Badge>
                </div>
                <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
                  {modelLabel(p.model_id)}{p.tone ? ` · ${p.tone}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" className="text-xs" onClick={() => openEdit(p)}>Edit</Button>
                <Button variant="ghost" className="text-xs" onClick={() => toggleEnabled(p)}>{p.enabled ? 'Disable' : 'Enable'}</Button>
                <Button variant="danger" className="text-xs" onClick={() => removePersona(p)}>Remove</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        title={editingId ? 'Edit persona' : 'Add persona'}
        onClose={() => setModalOpen(false)}
        onSubmit={submit}
        submitLabel={editingId ? 'Save' : 'Create'}
        loading={saving}
        maxWidth="max-w-xl"
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Name" placeholder="e.g. Strategist" value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: (e.target as HTMLInputElement).value }))} />
            <Input label="Role (optional)" placeholder="e.g. Growth strategist" value={draft.role}
              onChange={(e) => setDraft((d) => ({ ...d, role: (e.target as HTMLInputElement).value }))} />
          </div>
          <Textarea label="Instructions" placeholder="What this persona focuses on, how it should think and respond…" rows={5}
            value={draft.instructions}
            onChange={(e) => setDraft((d) => ({ ...d, instructions: (e.target as HTMLTextAreaElement).value }))} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Tone (optional)" placeholder="e.g. direct, warm, professional" value={draft.tone}
              onChange={(e) => setDraft((d) => ({ ...d, tone: (e.target as HTMLInputElement).value }))} />
            <Dropdown label="Model" options={modelOptions} value={draft.model_id}
              onChange={(e) => setDraft((d) => ({ ...d, model_id: (e.target as HTMLSelectElement).value }))} />
          </div>
          <Checkbox label="Coordinator — frames the final answer when multiple personas are @mentioned"
            checked={draft.is_coordinator}
            onChange={(e) => setDraft((d) => ({ ...d, is_coordinator: (e.target as HTMLInputElement).checked }))} />
          {formErr && <p className="text-xs text-[var(--text-negative)]">{formErr}</p>}
        </div>
      </Modal>
    </div>
  );
}

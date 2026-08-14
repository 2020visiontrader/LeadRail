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

// Web forms (lead-capture) feature (migration 035_forms.sql). A form is a
// small, embeddable HTML form: `fields` is a whitelisted-shape JSONB array of
// {key, label, type, required}. The public submit endpoint
// (/api/public/forms/:id/submit) requires no session — it derives account_id
// from the form row itself (lib/forms/store.ts), never from the caller.

const FIELD_TYPES: { value: string; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email' },
  { value: 'tel', label: 'Phone' },
  { value: 'textarea', label: 'Textarea' },
];

interface FormField { key: string; label: string; type: 'text' | 'email' | 'tel' | 'textarea'; required: boolean }
interface FormRow {
  id: string;
  name: string;
  fields: FormField[];
  redirect_url: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}
interface Submission {
  id: string;
  data: Record<string, any>;
  contact_id: string | null;
  created_at: string;
}

const EMPTY_FIELD: FormField = { key: '', label: '', type: 'text', required: false };

export default function Forms() {
  const { notify } = useToast();
  const [forms, setForms] = useState<FormRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Record<string, number>>({});

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [redirectUrl, setRedirectUrl] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [fields, setFields] = useState<FormField[]>([{ ...EMPTY_FIELD, key: 'email', label: 'Email', type: 'email', required: true }]);
  const [saving, setSaving] = useState(false);

  const [panelFormId, setPanelFormId] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ forms: FormRow[] }>('/api/forms');
      const list = res.forms || [];
      setForms(list);
      // Best-effort submission counts per form, for the list view.
      const entries = await Promise.all(
        list.map(async (f) => {
          try {
            const r = await apiGet<{ submissions: Submission[] }>(`/api/forms/${f.id}/submissions`);
            return [f.id, (r.submissions || []).length] as const;
          } catch {
            return [f.id, 0] as const;
          }
        }),
      );
      setCounts(Object.fromEntries(entries));
    } catch (e: any) {
      notify(e?.message || 'Failed to load forms', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setEditingId(null);
    setName('');
    setRedirectUrl('');
    setEnabled(true);
    setFields([{ ...EMPTY_FIELD, key: 'email', label: 'Email', type: 'email', required: true }]);
    setModalOpen(true);
  }

  function openEdit(f: FormRow) {
    setEditingId(f.id);
    setName(f.name);
    setRedirectUrl(f.redirect_url || '');
    setEnabled(f.enabled);
    setFields(f.fields?.length ? JSON.parse(JSON.stringify(f.fields)) : [{ ...EMPTY_FIELD }]);
    setModalOpen(true);
  }

  function addFieldRow() {
    setFields((prev) => [...prev, { ...EMPTY_FIELD }]);
  }

  function removeFieldRow(idx: number) {
    setFields((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateFieldRow(idx: number, patch: Partial<FormField>) {
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  }

  function cleanFields(): FormField[] {
    return fields
      .map((f) => ({ ...f, key: f.key.trim(), label: f.label.trim() }))
      .filter((f) => f.key);
  }

  async function save() {
    const n = name.trim();
    if (!n) { notify('Name is required', 'error'); return; }
    const clean = cleanFields();
    if (!clean.length) { notify('Add at least one field', 'error'); return; }
    setSaving(true);
    try {
      if (editingId) {
        await apiSend(`/api/forms/${editingId}`, 'PATCH', {
          name: n, fields: clean, redirect_url: redirectUrl.trim() || null, enabled,
        });
      } else {
        await apiSend('/api/forms', 'POST', {
          name: n, fields: clean, redirect_url: redirectUrl.trim() || undefined, enabled,
        });
      }
      notify('Form saved', 'success');
      setModalOpen(false);
      await load();
    } catch (e: any) {
      notify(e?.message || 'Failed to save form', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function remove(f: FormRow) {
    if (!confirm(`Delete form "${f.name}"?`)) return;
    try {
      await apiSend(`/api/forms/${f.id}`, 'DELETE');
      if (panelFormId === f.id) setPanelFormId(null);
      await load();
    } catch (e: any) {
      notify(e?.message || 'Failed to delete', 'error');
    }
  }

  async function openPanel(f: FormRow) {
    setPanelFormId(panelFormId === f.id ? null : f.id);
    if (panelFormId === f.id) return;
    setLoadingSubmissions(true);
    try {
      const res = await apiGet<{ submissions: Submission[] }>(`/api/forms/${f.id}/submissions`);
      setSubmissions(res.submissions || []);
    } catch (e: any) {
      notify(e?.message || 'Failed to load submissions', 'error');
    } finally {
      setLoadingSubmissions(false);
    }
  }

  function submitUrl(id: string): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/api/public/forms/${id}/submit`;
  }

  function embedSnippet(f: FormRow): string {
    const url = submitUrl(f.id);
    const inputs = f.fields
      .map((field) => {
        if (field.type === 'textarea') {
          return `  <textarea name="${field.key}" placeholder="${field.label}"${field.required ? ' required' : ''}></textarea>`;
        }
        return `  <input type="${field.type}" name="${field.key}" placeholder="${field.label}"${field.required ? ' required' : ''} />`;
      })
      .join('\n');
    return `<form id="${f.id}-form">\n${inputs}\n  <button type="submit">Submit</button>\n</form>\n<script>\n  document.getElementById('${f.id}-form').addEventListener('submit', async function (e) {\n    e.preventDefault();\n    const data = Object.fromEntries(new FormData(e.target).entries());\n    const res = await fetch('${url}', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify(data),\n    });\n    const result = await res.json();\n    if (result.ok && result.redirect_url) window.location.href = result.redirect_url;\n  });\n</script>`;
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify('Copied', 'success');
    } catch {
      notify('Copy failed', 'error');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">Forms</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Embeddable lead-capture forms. Each submission is saved and, when it includes an email, upserted as a contact.
          </p>
        </div>
        <Button className="shrink-0" onClick={openCreate}>+ New form</Button>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : forms.length === 0 ? (
        <EmptyState title="No forms yet" hint="Create your first lead-capture form above." />
      ) : (
        <div className="space-y-3">
          {forms.map((f) => (
            <div key={f.id} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--text-primary)]">{f.name}</span>
                    <Badge tone={f.enabled ? 'green' : 'gray'}>{f.enabled ? 'enabled' : 'disabled'}</Badge>
                    <Badge tone="blue">{counts[f.id] ?? 0} submission{(counts[f.id] ?? 0) === 1 ? '' : 's'}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">{f.fields.length} field{f.fields.length === 1 ? '' : 's'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => openPanel(f)}>{panelFormId === f.id ? 'Hide' : 'View'}</Button>
                  <Button variant="secondary" onClick={() => openEdit(f)}>Edit</Button>
                  <Button variant="danger" onClick={() => remove(f)}>Delete</Button>
                </div>
              </div>

              {panelFormId === f.id && (
                <div className="mt-4 space-y-4 border-t border-[var(--border-default)] pt-4">
                  <div>
                    <span className="text-xs font-medium text-[var(--text-secondary)]">Public submit URL</span>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="grow truncate rounded-md border border-[var(--border-default)] bg-[var(--bg-raised)] px-2 py-1.5 text-xs text-[var(--text-primary)]">
                        {submitUrl(f.id)}
                      </code>
                      <Button variant="secondary" onClick={() => copyToClipboard(submitUrl(f.id))}>Copy</Button>
                    </div>
                  </div>

                  <div>
                    <span className="text-xs font-medium text-[var(--text-secondary)]">Embed snippet</span>
                    <div className="mt-1">
                      <pre className="max-h-56 overflow-auto rounded-md border border-[var(--border-default)] bg-[var(--bg-raised)] p-3 text-[11px] text-[var(--text-secondary)]">
                        {embedSnippet(f)}
                      </pre>
                      <Button className="mt-2" variant="secondary" onClick={() => copyToClipboard(embedSnippet(f))}>Copy snippet</Button>
                    </div>
                  </div>

                  <div>
                    <span className="text-xs font-medium text-[var(--text-secondary)]">Submissions</span>
                    {loadingSubmissions ? (
                      <LoadingSpinner />
                    ) : submissions.length === 0 ? (
                      <p className="mt-2 text-xs text-[var(--text-muted)]">No submissions yet.</p>
                    ) : (
                      <ul className="mt-2 max-h-56 space-y-1 overflow-auto text-xs text-[var(--text-secondary)]">
                        {submissions.map((s) => (
                          <li key={s.id} className="truncate rounded-md border border-[var(--border-default)] bg-[var(--bg-raised)] px-2 py-1.5">
                            {Object.entries(s.data).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                            {s.contact_id ? '' : ' (no contact)'}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        title={editingId ? 'Edit form' : 'New form'}
        onClose={() => setModalOpen(false)}
        onSubmit={save}
        submitLabel={saving ? 'Saving…' : 'Save form'}
        loading={saving}
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Name" placeholder="e.g. Contact us" value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="Redirect URL (optional)" placeholder="https://example.com/thank-you" value={redirectUrl} onChange={(e) => setRedirectUrl(e.target.value)} />
          </div>

          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled (public submit endpoint accepts submissions)
          </label>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--text-secondary)]">Fields</span>
              <button className="text-xs text-[var(--brand)]" onClick={addFieldRow}>+ add field</button>
            </div>
            <div className="space-y-2">
              {fields.map((f, idx) => (
                <div key={idx} className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border-default)] p-2">
                  <Input
                    className="w-32"
                    placeholder="key"
                    value={f.key}
                    onChange={(e) => updateFieldRow(idx, { key: e.target.value })}
                  />
                  <Input
                    className="w-40"
                    placeholder="label"
                    value={f.label}
                    onChange={(e) => updateFieldRow(idx, { label: e.target.value })}
                  />
                  <Dropdown
                    className="w-32"
                    options={FIELD_TYPES}
                    value={f.type}
                    onChange={(e) => updateFieldRow(idx, { type: (e.target as HTMLSelectElement).value as FormField['type'] })}
                  />
                  <label className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={(e) => updateFieldRow(idx, { required: e.target.checked })}
                    />
                    required
                  </label>
                  <button className="text-xs text-[var(--status-negative)]" onClick={() => removeFieldRow(idx)}>remove</button>
                </div>
              ))}
              {fields.length === 0 && (
                <p className="text-xs text-[var(--text-muted)]">No fields — add at least one before saving.</p>
              )}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

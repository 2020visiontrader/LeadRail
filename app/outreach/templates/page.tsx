'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import Badge from '@/components/Badge';
import Input from '@/components/Input';
import Textarea from '@/components/Textarea';
import Button from '@/components/Button';
import EmailPreview from '@/components/EmailPreview';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';

interface Template { id: string; category?: string | null; name: string; subject?: string | null; body: string; }

export default function Templates() {
  const { notify } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [active, setActive] = useState<Template | null>(null);
  const [draft, setDraft] = useState<Template | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [refining, setRefining] = useState(false);

  const loadTemplates = () =>
    apiGet<Template[]>('/api/templates')
      .then((t) => { const list = Array.isArray(t) ? t : []; setTemplates(list); setActive((cur) => cur || list[0] || null); return list; })
      .catch(() => []);

  useEffect(() => { loadTemplates().finally(() => setLoading(false)); }, []);
  useEffect(() => { setDraft(active ? { ...active } : null); setInstruction(''); }, [active]);

  const dirty = !!draft && !!active && (draft.name !== active.name || draft.subject !== active.subject || draft.body !== active.body || draft.category !== active.category);

  const createNew = async () => {
    try {
      const tpl = await apiSend<Template>('/api/templates', 'POST', {
        name: 'Untitled template', subject: 'New subject', body: '<p>Hi {{name}},</p><p></p>', category: 'other',
      });
      await loadTemplates();
      setActive(tpl);
      notify('Template created');
    } catch (e: any) { notify(e.message || 'Create failed', 'error'); }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await apiSend<Template>(`/api/templates/${draft.id}`, 'PATCH', {
        name: draft.name, subject: draft.subject, body: draft.body, category: draft.category,
      });
      setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      setActive(updated);
      notify('Saved');
    } catch (e: any) { notify(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  };

  const refine = async () => {
    if (!draft || !instruction.trim()) { notify('Describe how to change it', 'error'); return; }
    setRefining(true);
    try {
      const { template } = await apiSend<{ template: { subject: string; body: string } }>('/api/templates/refine', 'POST', {
        instruction: instruction.trim(),
        current: { name: draft.name, subject: draft.subject, body: draft.body },
      });
      setDraft({ ...draft, subject: template.subject || draft.subject, body: template.body || draft.body });
      setInstruction('');
      notify('Refined — review and Save');
    } catch (e: any) {
      notify(e.message === 'not_configured' ? 'LeadRail AI is temporarily unavailable' : e.message || 'Refine failed', 'error');
    } finally { setRefining(false); }
  };

  const remove = async () => {
    if (!draft || !confirm(`Delete “${draft.name}”?`)) return;
    try {
      await apiSend(`/api/templates/${draft.id}`, 'DELETE');
      const rest = templates.filter((t) => t.id !== draft.id);
      setTemplates(rest); setActive(rest[0] || null);
      notify('Deleted');
    } catch (e: any) { notify(e.message || 'Delete failed', 'error'); }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/outreach" className="text-sm text-indigo-600 hover:underline">← Back to outreach</Link>
          <h1 className="mt-2 text-2xl font-bold">Templates</h1>
        </div>
        <Button onClick={createNew}>+ New template</Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <ul className="space-y-2">
          {templates.length === 0 && <li className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No templates yet. Create one to start.</li>}
          {templates.map((t) => (
            <li key={t.id}>
              <button onClick={() => setActive(t)} className={`w-full rounded-lg border p-3 text-left text-sm ${active?.id === t.id ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                <div className="flex items-center justify-between"><span className="font-medium">{t.name}</span>{t.category && <Badge tone="indigo">{t.category}</Badge>}</div>
              </button>
            </li>
          ))}
        </ul>

        <div className="space-y-4 lg:col-span-2">
          {draft ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                <Input label="Category" value={draft.category || ''} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
              </div>
              <Input label="Subject" value={draft.subject || ''} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
              <Textarea label="Body (HTML) — use {{name}} and {{company}} tokens" rows={8} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />

              <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-3">
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Input label="✨ Refine with AI" placeholder="e.g. make it shorter and add a clear CTA to book a call"
                      value={instruction} onChange={(e) => setInstruction(e.target.value)}
                      onKeyDown={(e: any) => { if (e.key === 'Enter') refine(); }} />
                  </div>
                  <Button variant="secondary" loading={refining} onClick={refine}>Refine</Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={save} loading={saving} disabled={!dirty}>{dirty ? 'Save changes' : 'Saved'}</Button>
                <Link href={`/outreach?templateId=${draft.id}`}><Button variant="secondary">Use in outreach →</Button></Link>
                <Button variant="danger" onClick={remove}>Delete</Button>
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold">Preview</h3>
                <EmailPreview subject={draft.subject || ''} html={draft.body} />
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
              Select a template to edit, or create a new one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

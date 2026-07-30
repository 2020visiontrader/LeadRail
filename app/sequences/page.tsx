'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Button from '@/components/Button';
import Modal from '@/components/Modal';
import Input from '@/components/Input';
import Textarea from '@/components/Textarea';
import Dropdown from '@/components/Dropdown';
import Badge from '@/components/Badge';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import { Sequence } from '@/lib/types';

interface Venture { id: string; name: string; account_id: string }

export default function SequencesPage() {
  const { notify } = useToast();
  const router = useRouter();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [venture, setVenture] = useState<Venture | null>(null);
  const [rows, setRows] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', channel: 'email', steps: 'Day 0 | Intro | Hi {{name}}, ...\nDay 3 | Follow-up | Just circling back ...' });
  const [aiDescription, setAiDescription] = useState('');
  const [generating, setGenerating] = useState(false);

  useEffect(() => { apiGet<{ ventures: Venture[] }>('/api/ventures').then((d) => { setVentures(d.ventures || []); setVenture((c) => c || d.ventures?.[0] || null); }).catch(() => {}); }, []);
  const load = useCallback(async () => {
    if (!venture) return; setLoading(true);
    try { setRows(await apiGet<Sequence[]>(`/api/sequences?brandId=${venture.id}`)); }
    catch { setRows([]); } finally { setLoading(false); }
  }, [venture]);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.name.trim() || !venture) { notify('Name required', 'error'); return; }
    // parse "delayLabel | subject | body" lines into steps
    const steps = form.steps.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
      const [delay, subject, ...rest] = l.split('|').map((s) => s.trim());
      const m = /(\d+)/.exec(delay || ''); const days = m ? Number(m[1]) : i;
      return { step_order: i, delay_hours: days * 24, subject: subject || `Step ${i + 1}`, body: rest.join(' | ') || '' };
    });
    setSaving(true);
    try {
      const created = await apiSend<Sequence>('/api/sequences', 'POST', { accountId: venture.account_id, brandId: venture.id, name: form.name.trim(), channel: form.channel, steps });
      notify('Sequence created — now enroll leads'); setOpen(false); setForm({ ...form, name: '' });
      // Go straight to the detail page so the user can enroll contacts and send.
      if (created?.id) router.push(`/sequences/${created.id}`); else load();
    } catch (e: any) { notify(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  };

  const toggle = async (s: Sequence) => {
    try {
      await apiSend(`/api/sequences/${s.id}`, 'PATCH', { is_active: !s.is_active });
      setRows((prev) => prev.map((x) => (x.id === s.id ? { ...x, is_active: !x.is_active } : x)));
      notify(!s.is_active ? 'Activated' : 'Paused');
    } catch (e: any) { notify(e.message || 'Failed', 'error'); }
  };

  const generateWithAi = async () => {
    if (!aiDescription.trim() || !venture) { notify('Describe the sequence you want', 'error'); return; }
    setGenerating(true);
    try {
      const draft = await apiSend<{ name: string; steps: { step_order: number; delay_hours: number; subject: string; body: string }[] }>(
        '/api/sequences/generate',
        'POST',
        { accountId: venture.account_id, brandId: venture.id, ventureName: venture.name, description: aiDescription.trim() }
      );
      const stepsText = (draft.steps || [])
        .sort((a, b) => a.step_order - b.step_order)
        .map((s) => `Day ${Math.round((s.delay_hours || 0) / 24)} | ${s.subject} | ${s.body}`)
        .join('\n');
      setForm({ name: draft.name || form.name, channel: form.channel, steps: stepsText || form.steps });
      setOpen(true);
      notify('Draft generated — review and create');
    } catch (e: any) { notify(e.message || 'Generation failed', 'error'); }
    finally { setGenerating(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-bold">Sequences</h1><p className="text-sm text-slate-500">Multi-step outreach cadences. Steps drain on the Hermes cron once contacts are enrolled.</p></div>
        <div className="flex items-center gap-2">
          <Dropdown value={venture?.id || ''} onChange={(e) => setVenture(ventures.find((v) => v.id === e.target.value) || null)} options={ventures.map((v) => ({ value: v.id, label: v.name }))} />
          <Button onClick={() => setOpen(true)}>+ New Sequence</Button>
        </div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold">Generate a sequence with AI</h2>
        <p className="mt-1 text-xs text-slate-500">Describe the cadence you want and the AI drafts the steps for you to review.</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <Textarea
            rows={2}
            placeholder="e.g. 3-step cold outreach for enterprise MCNs: intro, case-study follow-up after 3 days, breakup after 7 days"
            value={aiDescription}
            onChange={(e) => setAiDescription(e.target.value)}
          />
          <Button onClick={generateWithAi} disabled={generating}>{generating ? 'Generating…' : 'Generate with AI'}</Button>
        </div>
      </div>
      {loading ? <LoadingSpinner /> : rows.length === 0 ? (
        <EmptyState icon="🔁" title="No sequences yet" hint="Create a cadence, then enroll leads from the Leads page." action={<Button onClick={() => setOpen(true)}>New Sequence</Button>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((s) => (
            <div key={s.id} className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-indigo-300 hover:shadow-sm">
              <div className="flex items-center justify-between">
                <Link href={`/sequences/${s.id}`} className="font-semibold hover:text-indigo-600">{s.name}</Link>
                <Badge tone={s.is_active ? 'green' : 'gray'}>{s.is_active ? 'active' : 'paused'}</Badge>
              </div>
              <p className="mt-1 text-xs text-slate-500">{s.channel} · created {new Date(s.created_at).toLocaleDateString()}</p>
              <div className="mt-3 flex items-center gap-2">
                <Link href={`/sequences/${s.id}`}><Button variant="secondary">Open & enroll</Button></Link>
                <Button variant="secondary" onClick={() => toggle(s)}>{s.is_active ? 'Pause' : 'Activate'}</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Modal isOpen={open} title="New Sequence" onClose={() => setOpen(false)} onSubmit={create} submitLabel="Create" loading={saving}>
        <div className="space-y-4">
          <Input label="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Dropdown label="Channel" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} options={[{ value: 'email', label: 'email' }]} />
          <Textarea label="Steps (one per line: delay | subject | body)" rows={5} value={form.steps} onChange={(e) => setForm({ ...form, steps: e.target.value })} />
        </div>
      </Modal>
    </div>
  );
}

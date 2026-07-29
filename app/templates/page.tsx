'use client';
import { useEffect, useState, useCallback } from 'react';
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
import { MessageTemplate } from '@/lib/types';

interface Venture { id: string; name: string; account_id: string }

export default function TemplatesPage() {
  const { notify } = useToast();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [venture, setVenture] = useState<Venture | null>(null);
  const [rows, setRows] = useState<MessageTemplate[]>([]);
  const [active, setActive] = useState<MessageTemplate | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', category: '', subject: '', body: '' });

  useEffect(() => { apiGet<{ ventures: Venture[] }>('/api/ventures').then((d) => { setVentures(d.ventures || []); setVenture((c) => c || d.ventures?.[0] || null); }).catch(() => {}); }, []);
  const load = useCallback(async () => {
    if (!venture) return; setLoading(true);
    try { const t = await apiGet<MessageTemplate[]>(`/api/templates?accountId=${venture.account_id}&brandId=${venture.id}`); setRows(t); setActive(t[0] || null); }
    catch { setRows([]); } finally { setLoading(false); }
  }, [venture]);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.name.trim() || !form.body.trim() || !venture) { notify('Name and body required', 'error'); return; }
    setSaving(true);
    try {
      await apiSend('/api/templates', 'POST', { accountId: venture.account_id, brandId: venture.id, name: form.name.trim(), category: form.category || null, subject: form.subject || null, body: form.body });
      notify('Template saved'); setOpen(false); setForm({ name: '', category: '', subject: '', body: '' }); load();
    } catch (e: any) { notify(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  };
  const remove = async (t: MessageTemplate) => {
    if (!confirm(`Delete ${t.name}?`)) return;
    try { await apiSend(`/api/templates/${t.id}`, 'DELETE'); notify('Deleted'); setActive(null); load(); }
    catch (e: any) { notify(e.message || 'Delete failed', 'error'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-bold">Templates</h1><p className="text-sm text-slate-500">Reusable message templates — pick one into a sequence or a one-off send.</p></div>
        <div className="flex items-center gap-2">
          <Dropdown value={venture?.id || ''} onChange={(e) => setVenture(ventures.find((v) => v.id === e.target.value) || null)} options={ventures.map((v) => ({ value: v.id, label: v.name }))} />
          <Button onClick={() => setOpen(true)}>+ New Template</Button>
        </div>
      </div>
      {loading ? <LoadingSpinner /> : rows.length === 0 ? (
        <EmptyState icon="📝" title="No templates yet" hint="Create your first reusable template." action={<Button onClick={() => setOpen(true)}>New Template</Button>} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <ul className="space-y-2">
            {rows.map((t) => (
              <li key={t.id}>
                <button onClick={() => setActive(t)} className={`w-full rounded-lg border p-3 text-left text-sm ${active?.id === t.id ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                  <div className="flex items-center justify-between"><span className="font-medium">{t.name}</span>{t.category && <Badge tone="indigo">{t.category}</Badge>}</div>
                </button>
              </li>
            ))}
          </ul>
          <div className="lg:col-span-2">
            {active && (
              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{active.subject || active.name}</h2><Button variant="danger" onClick={() => remove(active)}>Delete</Button></div>
                <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{active.body}</p>
              </div>
            )}
          </div>
        </div>
      )}
      <Modal isOpen={open} title="New Template" onClose={() => setOpen(false)} onSubmit={create} submitLabel="Save" loading={saving}>
        <div className="space-y-4">
          <Input label="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input label="Category" placeholder="intro / follow-up / break-up" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          <Input label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          <Textarea label="Body *" rows={6} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </div>
      </Modal>
    </div>
  );
}

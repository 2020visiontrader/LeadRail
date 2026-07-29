'use client';
import { useState, useEffect, useCallback } from 'react';
import Modal from '@/components/Modal';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Dropdown from '@/components/Dropdown';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import type { Activity } from '@/lib/types';

interface Venture { id: string; name: string; account_id: string }
const TYPES = ['task', 'call', 'meeting', 'email', 'event'];
const empty = { type: 'task', subject: '', body: '', due_at: '' };
const ICON: Record<string, string> = { task: '✓', call: '📞', meeting: '🤝', email: '✉️', event: '📅' };

export default function ActivitiesPage() {
  const { notify } = useToast();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [venture, setVenture] = useState<Venture | null>(null);
  const [rows, setRows] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet<{ ventures: Venture[] }>('/api/ventures').then((d) => {
      const vs = d.ventures || []; setVentures(vs); setVenture((c) => c || vs[0] || null);
    }).catch(() => setVentures([]));
  }, []);

  const load = useCallback(async () => {
    if (!venture) return;
    setLoading(true);
    try {
      const data = await apiGet<Activity[]>(`/api/activities?accountId=${venture.account_id}`);
      setRows(Array.isArray(data) ? data : []);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [venture]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!venture || !form.type) { notify('Type is required', 'error'); return; }
    setSaving(true);
    try {
      await apiSend('/api/activities', 'POST', {
        account_id: venture.account_id, brand_id: venture.id, type: form.type,
        subject: form.subject || undefined, body: form.body || undefined,
        due_at: form.due_at ? new Date(form.due_at).toISOString() : undefined,
      });
      notify('Activity logged', 'success'); setAddOpen(false); setForm(empty); load();
    } catch (e: any) { notify(e.message || 'Failed', 'error'); } finally { setSaving(false); }
  };

  const toggle = async (a: Activity) => {
    const status = a.status === 'done' ? 'open' : 'done';
    setRows((rs) => rs.map((r) => r.id === a.id ? { ...r, status } : r));
    try { await apiSend(`/api/activities/${a.id}`, 'PATCH', { status, completed_at: status === 'done' ? new Date().toISOString() : null }); }
    catch (e: any) { notify(e.message || 'Failed', 'error'); load(); }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Activities</h1>
          <p className="text-sm text-slate-500">Tasks, calls, meetings, and logged touchpoints.</p>
        </div>
        <div className="flex items-center gap-3">
          <Dropdown value={venture?.id || ''} onChange={(e) => setVenture(ventures.find((v) => v.id === e.target.value) || null)}
            options={ventures.map((v) => ({ value: v.id, label: v.name }))} />
          <Button onClick={() => setAddOpen(true)}>+ Log Activity</Button>
        </div>
      </div>

      {loading ? <p className="text-slate-400">Loading…</p> : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 py-16 text-center text-slate-400">No activities yet.</div>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <li key={a.id} className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
              <button onClick={() => toggle(a)} title="Toggle done"
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${a.status === 'done' ? 'border-green-500 bg-green-500 text-white' : 'border-slate-300 text-slate-400'}`}>
                {a.status === 'done' ? '✓' : ICON[a.type] || '•'}
              </button>
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-medium ${a.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-900'}`}>{a.subject || a.type}</div>
                {a.body && <div className="text-xs text-slate-500">{a.body}</div>}
                <div className="mt-0.5 text-xs text-slate-400">{a.type}{a.due_at ? ` · due ${new Date(a.due_at).toLocaleDateString()}` : ''}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal isOpen={addOpen} title="Log Activity" onClose={() => setAddOpen(false)} onSubmit={save} submitLabel="Save" loading={saving}>
        <div className="space-y-3">
          <Dropdown label="Type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}
            options={TYPES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }))} />
          <Input label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          <Input label="Notes" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          <Input label="Due date" type="date" value={form.due_at} onChange={(e) => setForm({ ...form, due_at: e.target.value })} />
        </div>
      </Modal>
    </div>
  );
}

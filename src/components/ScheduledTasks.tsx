'use client';
import { useEffect, useState, useCallback } from 'react';
import Badge from '@/components/Badge';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Textarea from '@/components/Textarea';
import Dropdown from '@/components/Dropdown';
import Modal from '@/components/Modal';
import LoadingSpinner from '@/components/LoadingSpinner';
import EmptyState from '@/components/EmptyState';
import KPICard from '@/components/KPICard';
import { apiGet, apiSend } from '@/lib/api';

// Settings -> Scheduled tasks. Recurring agent prompts (migration
// 027_scheduled_tasks.sql) run on a NAMED interval only (hourly/daily/weekly —
// no cron expressions). Swept by app/api/scheduled-tasks/run-due and, when the
// hermes tick fires, by the same sweep call there.

type Interval = 'hourly' | 'daily' | 'weekly';

interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  interval: Interval;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
  last_result: string | null;
}

const INTERVAL_OPTIONS = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

const EMPTY_DRAFT = { name: '', prompt: '', interval: 'daily' as Interval };
type Draft = typeof EMPTY_DRAFT;

function statusTone(status: string | null): 'green' | 'red' | 'gray' {
  if (status === 'ok') return 'green';
  if (status === 'error') return 'red';
  return 'gray';
}

function fmt(dt: string | null): string {
  return dt ? new Date(dt).toLocaleString() : '—';
}

export default function ScheduledTasks() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
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
      const res = await apiGet<{ tasks: ScheduledTask[] }>('/api/scheduled-tasks');
      setTasks(res.tasks || []);
    } catch {
      /* surfaced via empty state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFormErr(null);
    setModalOpen(true);
  }

  function openEdit(t: ScheduledTask) {
    setEditingId(t.id);
    setDraft({ name: t.name, prompt: t.prompt, interval: t.interval });
    setFormErr(null);
    setModalOpen(true);
  }

  async function submit() {
    if (!draft.name.trim()) { setFormErr('Name is required'); return; }
    if (!draft.prompt.trim()) { setFormErr('Prompt is required'); return; }
    setSaving(true);
    setFormErr(null);
    const payload = { name: draft.name.trim(), prompt: draft.prompt.trim(), interval: draft.interval };
    try {
      if (editingId) {
        await apiSend(`/api/scheduled-tasks/${editingId}`, 'PATCH', payload);
      } else {
        await apiSend('/api/scheduled-tasks', 'POST', payload);
      }
      setModalOpen(false);
      await load();
    } catch (e: any) {
      setFormErr(e?.message || 'Could not save scheduled task');
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(t: ScheduledTask) {
    try {
      await apiSend(`/api/scheduled-tasks/${t.id}`, 'PATCH', { enabled: !t.enabled });
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not update task' });
    }
  }

  async function removeTask(t: ScheduledTask) {
    try {
      await apiSend(`/api/scheduled-tasks/${t.id}`, 'DELETE');
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not remove task' });
    }
  }

  const activeCount = tasks.filter((t) => t.enabled).length;

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Scheduled tasks</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            Recurring agent prompts, run on a named interval (hourly, daily, or weekly).
          </p>
        </div>
        <Button variant="secondary" className="shrink-0 text-xs" onClick={openCreate}>+ New task</Button>
      </div>

      {!loading && tasks.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          <KPICard label="Active tasks" value={activeCount} icon="⏱" />
        </div>
      )}

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : tasks.length === 0 ? (
        <EmptyState icon="⏱" title="No scheduled tasks" hint="Create one to have the agent run a prompt on a recurring interval." />
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => (
            <div key={t.id} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{t.name}</span>
                    <Badge tone="gray">{t.interval}</Badge>
                    <Badge tone={t.enabled ? 'green' : 'gray'}>{t.enabled ? 'enabled' : 'disabled'}</Badge>
                    {t.last_status && <Badge tone={statusTone(t.last_status)}>{t.last_status === 'ok' ? 'last run ok' : 'last run failed'}</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">{t.prompt}</p>
                  <p className="mt-0.5 text-xs text-[var(--text-muted)]">Last run: {fmt(t.last_run_at)} · Next run: {fmt(t.next_run_at)}</p>
                  {t.last_result && <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">Result: {t.last_result}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="ghost" className="text-xs" onClick={() => openEdit(t)}>Edit</Button>
                  <Button variant="ghost" className="text-xs" onClick={() => toggleEnabled(t)}>{t.enabled ? 'Disable' : 'Enable'}</Button>
                  <Button variant="danger" className="text-xs" onClick={() => removeTask(t)}>Remove</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        title={editingId ? 'Edit scheduled task' : 'New scheduled task'}
        onClose={() => setModalOpen(false)}
        onSubmit={submit}
        submitLabel={editingId ? 'Save' : 'Create'}
        loading={saving}
        maxWidth="max-w-xl"
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Name" placeholder="e.g. Daily pipeline digest" value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: (e.target as HTMLInputElement).value }))} />
            <Dropdown label="Interval" options={INTERVAL_OPTIONS} value={draft.interval}
              onChange={(e) => setDraft((d) => ({ ...d, interval: (e.target as HTMLSelectElement).value as Interval }))} />
          </div>
          <Textarea label="Prompt" placeholder="What should the agent do each time this runs?" rows={4} value={draft.prompt}
            onChange={(e) => setDraft((d) => ({ ...d, prompt: (e.target as HTMLTextAreaElement).value }))} />
          {formErr && <p className="text-xs text-[var(--text-negative)]">{formErr}</p>}
        </div>
      </Modal>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import Button from '@/components/Button';
import Badge from '@/components/Badge';
import Input from '@/components/Input';
import Modal from '@/components/Modal';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';

type Status = 'draft' | 'active' | 'paused' | 'archived';
type Trigger = 'manual' | 'lead_created' | 'tag_added' | 'stage_changed';
type NodeType = 'trigger' | 'send_email' | 'wait' | 'condition' | 'goal' | 'exit';

interface Edge { to: string; when?: string | null }
interface JNode { id: string; type: NodeType; config: Record<string, any>; next: Edge[] }
interface Journey {
  id: string;
  name: string;
  description: string | null;
  status: Status;
  trigger: Trigger;
  graph: { nodes: JNode[] };
  stats: Record<string, any>;
  created_at: string;
  updated_at: string;
}

const TRIGGERS: { key: Trigger; label: string }[] = [
  { key: 'manual', label: 'Manual' },
  { key: 'lead_created', label: 'Lead created' },
  { key: 'tag_added', label: 'Tag added' },
  { key: 'stage_changed', label: 'Stage changed' },
];

const NODE_TYPES: { key: NodeType; label: string; icon: string }[] = [
  { key: 'trigger', label: 'Trigger', icon: '⚡' },
  { key: 'send_email', label: 'Send email', icon: '✉️' },
  { key: 'wait', label: 'Wait', icon: '⏱️' },
  { key: 'condition', label: 'Condition', icon: '🔀' },
  { key: 'goal', label: 'Goal', icon: '🎯' },
  { key: 'exit', label: 'Exit', icon: '⏹️' },
];

function statusTone(s: Status): 'gray' | 'green' | 'blue' | 'amber' | 'red' {
  switch (s) {
    case 'active': return 'green';
    case 'paused': return 'amber';
    case 'archived': return 'red';
    default: return 'gray';
  }
}

function nodeMeta(t: NodeType) {
  return NODE_TYPES.find((n) => n.key === t) || { label: t, icon: '•' };
}

function newNodeId(existing: JNode[]): string {
  let i = existing.length + 1;
  let id = `n${i}`;
  const ids = new Set(existing.map((n) => n.id));
  while (ids.has(id)) { i++; id = `n${i}`; }
  return id;
}

export default function Journeys() {
  const { notify } = useToast();
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<Trigger>('manual');
  const [editing, setEditing] = useState<Journey | null>(null);
  const [nodes, setNodes] = useState<JNode[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ journeys: Journey[] }>('/api/journeys');
      setJourneys(res.journeys || []);
    } catch (e: any) {
      notify(e?.message || 'Failed to load journeys', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  async function create() {
    const n = name.trim();
    if (!n) return;
    setCreating(true);
    try {
      // Seed with a single trigger node so the graph is valid from the start.
      const graph = { nodes: [{ id: 'n1', type: 'trigger' as NodeType, config: { trigger }, next: [] }] };
      const j = await apiSend<Journey>('/api/journeys', 'POST', { name: n, trigger, graph });
      setName('');
      setTrigger('manual');
      await load();
      openEditor(j);
    } catch (e: any) {
      notify(e?.message || 'Failed to create journey', 'error');
    } finally {
      setCreating(false);
    }
  }

  function openEditor(j: Journey) {
    setEditing(j);
    setNodes(JSON.parse(JSON.stringify(j.graph?.nodes || [])));
  }

  function addNode(type: NodeType) {
    setNodes((prev) => [...prev, { id: newNodeId(prev), type, config: {}, next: [] }]);
  }

  function removeNode(id: string) {
    setNodes((prev) =>
      prev
        .filter((n) => n.id !== id)
        .map((n) => ({ ...n, next: n.next.filter((e) => e.to !== id) })),
    );
  }

  function setNodeConfig(id: string, key: string, value: string) {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, config: { ...n.config, [key]: value } } : n)));
  }

  function setNodeEdge(id: string, idx: number, to: string) {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.id !== id) return n;
        const next = [...n.next];
        next[idx] = { ...next[idx], to };
        return { ...n, next };
      }),
    );
  }

  function addEdge(id: string, when?: string) {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, next: [...n.next, { to: '', when: when ?? null }] } : n)));
  }

  function removeEdge(id: string, idx: number) {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, next: n.next.filter((_, i) => i !== idx) } : n)));
  }

  async function saveGraph() {
    if (!editing) return;
    // Drop any empty edges the user added but never wired.
    const clean = nodes.map((n) => ({ ...n, next: n.next.filter((e) => e.to) }));
    setSaving(true);
    try {
      const j = await apiSend<Journey>(`/api/journeys/${editing.id}`, 'PATCH', { graph: { nodes: clean } });
      notify('Journey saved', 'success');
      setEditing(null);
      setNodes([]);
      await load();
      void j;
    } catch (e: any) {
      notify(e?.message || 'Save failed (check for dangling steps)', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(j: Journey, status: Status) {
    try {
      await apiSend(`/api/journeys/${j.id}`, 'PATCH', { status });
      await load();
    } catch (e: any) {
      notify(e?.message || 'Failed to update status', 'error');
    }
  }

  async function remove(j: Journey) {
    if (!confirm(`Delete journey "${j.name}"? This cannot be undone.`)) return;
    try {
      await apiSend(`/api/journeys/${j.id}`, 'DELETE');
      await load();
    } catch (e: any) {
      notify(e?.message || 'Failed to delete', 'error');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--ink)]">Journeys</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Branching automation graphs — the multi-step evolution of linear sequences. Add steps, connect them, then activate.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="grow">
          <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">New journey name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. New lead welcome" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Trigger</label>
          <select
            value={trigger}
            onChange={(e) => setTrigger(e.target.value as Trigger)}
            className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)]"
          >
            {TRIGGERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </div>
        <Button onClick={create} disabled={creating || !name.trim()}>{creating ? 'Creating…' : 'Create'}</Button>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : journeys.length === 0 ? (
        <EmptyState title="No journeys yet" hint="Create your first automation journey above." />
      ) : (
        <div className="space-y-3">
          {journeys.map((j) => (
            <div key={j.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[var(--ink)]">{j.name}</span>
                  <Badge tone={statusTone(j.status)}>{j.status}</Badge>
                  <span className="text-xs text-[var(--text-secondary)]">
                    {(j.graph?.nodes?.length || 0)} step{(j.graph?.nodes?.length || 0) === 1 ? '' : 's'} · {j.trigger}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => openEditor(j)}>Edit</Button>
                  {j.status !== 'active' ? (
                    <Button variant="secondary" onClick={() => setStatus(j, 'active')}>Activate</Button>
                  ) : (
                    <Button variant="secondary" onClick={() => setStatus(j, 'paused')}>Pause</Button>
                  )}
                  <Button variant="danger" onClick={() => remove(j)}>Delete</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Modal
          isOpen={!!editing}
          onClose={() => { setEditing(null); setNodes([]); }}
          title={`Edit: ${editing.name}`}
          onSubmit={saveGraph}
          submitLabel={saving ? 'Saving…' : 'Save journey'}
          loading={saving}
          maxWidth="max-w-3xl"
        >
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {NODE_TYPES.filter((t) => t.key !== 'trigger').map((t) => (
                <Button key={t.key} variant="secondary" onClick={() => addNode(t.key)}>
                  {t.icon} Add {t.label}
                </Button>
              ))}
            </div>

            <div className="space-y-3">
              {nodes.map((n) => {
                const meta = nodeMeta(n.type);
                return (
                  <div key={n.id} className="rounded-lg border border-[var(--border)] p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span>{meta.icon}</span>
                        <span className="font-medium text-[var(--ink)]">{meta.label}</span>
                        <span className="text-xs text-[var(--text-secondary)]">({n.id})</span>
                      </div>
                      {n.type !== 'trigger' && (
                        <Button variant="danger" onClick={() => removeNode(n.id)}>Remove</Button>
                      )}
                    </div>

                    {n.type === 'send_email' && (
                      <div className="mt-2 grid gap-2">
                        <Input value={n.config.subject || ''} onChange={(e) => setNodeConfig(n.id, 'subject', e.target.value)} placeholder="Email subject" />
                        <Input value={n.config.template || ''} onChange={(e) => setNodeConfig(n.id, 'template', e.target.value)} placeholder="Template id or body" />
                      </div>
                    )}
                    {n.type === 'wait' && (
                      <div className="mt-2">
                        <Input value={n.config.duration || ''} onChange={(e) => setNodeConfig(n.id, 'duration', e.target.value)} placeholder="e.g. 2d, 4h" />
                      </div>
                    )}
                    {n.type === 'condition' && (
                      <div className="mt-2">
                        <Input value={n.config.expr || ''} onChange={(e) => setNodeConfig(n.id, 'expr', e.target.value)} placeholder="e.g. opened_last_email" />
                      </div>
                    )}
                    {n.type === 'goal' && (
                      <div className="mt-2">
                        <Input value={n.config.label || ''} onChange={(e) => setNodeConfig(n.id, 'label', e.target.value)} placeholder="Goal name, e.g. Booked demo" />
                      </div>
                    )}

                    <div className="mt-3">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-xs font-medium text-[var(--text-secondary)]">Next steps</span>
                        <button className="text-xs text-[var(--brand-primary)]" onClick={() => addEdge(n.id, n.type === 'condition' ? 'yes' : undefined)}>+ add branch</button>
                      </div>
                      {n.next.length === 0 ? (
                        <p className="text-xs text-[var(--text-secondary)]">No next step (end of path).</p>
                      ) : (
                        <div className="space-y-2">
                          {n.next.map((e, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              {e.when != null && <span className="text-xs text-[var(--text-secondary)]">{e.when} →</span>}
                              <select
                                value={e.to}
                                onChange={(ev) => setNodeEdge(n.id, idx, ev.target.value)}
                                className="h-8 grow rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)]"
                              >
                                <option value="">— select step —</option>
                                {nodes.filter((t) => t.id !== n.id).map((t) => (
                                  <option key={t.id} value={t.id}>{nodeMeta(t.type).label} ({t.id})</option>
                                ))}
                              </select>
                              <button className="text-xs text-[var(--danger,#dc2626)]" onClick={() => removeEdge(n.id, idx)}>remove</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

          </div>
        </Modal>
      )}
    </div>
  );
}

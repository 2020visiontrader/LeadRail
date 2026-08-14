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

type StageKey = 'scout' | 'planner' | 'creator' | 'reviewer' | 'publisher' | 'analyst';
type StageStatus = 'pending' | 'running' | 'done' | 'failed';
type RunStatus = 'running' | 'completed' | 'failed';

interface StageResult {
  key: StageKey;
  status: StageStatus;
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface PipelineRun {
  id: string;
  topic: string;
  status: RunStatus;
  current_stage: StageKey | null;
  stages: StageResult[];
  output: any;
  created_at: string;
  updated_at: string;
}

const STAGES: { key: StageKey; label: string; icon: string }[] = [
  { key: 'scout', label: 'Scout', icon: '🔍' },
  { key: 'planner', label: 'Planner', icon: '🗺️' },
  { key: 'creator', label: 'Creator', icon: '✍️' },
  { key: 'reviewer', label: 'Reviewer', icon: '✅' },
  { key: 'publisher', label: 'Publisher', icon: '🚀' },
  { key: 'analyst', label: 'Analyst', icon: '📊' },
];

function stageTone(status?: StageStatus): 'gray' | 'green' | 'blue' | 'amber' | 'red' | 'indigo' {
  switch (status) {
    case 'done': return 'green';
    case 'running': return 'blue';
    case 'failed': return 'red';
    default: return 'gray';
  }
}

function runTone(status?: RunStatus): 'gray' | 'green' | 'blue' | 'amber' | 'red' | 'indigo' {
  switch (status) {
    case 'completed': return 'green';
    case 'running': return 'blue';
    case 'failed': return 'red';
    default: return 'gray';
  }
}

export default function ContentPipeline() {
  const { notify } = useToast();
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [topic, setTopic] = useState('');
  const [starting, setStarting] = useState(false);
  const [selected, setSelected] = useState<PipelineRun | null>(null);

  const loadRuns = useCallback(async () => {
    const data = await apiGet<{ runs: PipelineRun[] }>('/api/pipeline').catch(() => ({ runs: [] }));
    setRuns(Array.isArray(data?.runs) ? data.runs : []);
    setLoading(false);
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // Light polling while any run is in flight (or the selected run is) so a
  // long run's stages appear live without a manual refresh.
  useEffect(() => {
    const active = runs.some((r) => r.status === 'running') || selected?.status === 'running';
    if (!active) return;
    const t = setInterval(async () => {
      await loadRuns();
      if (selected) {
        const r = await apiGet<{ run: PipelineRun }>(`/api/pipeline/${selected.id}`).catch(() => null);
        if (r?.run) setSelected(r.run);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [runs, selected, loadRuns]);

  const start = async () => {
    if (!topic.trim()) { notify('Enter a topic first', 'error'); return; }
    setStarting(true);
    try {
      const r = await apiSend<{ run: PipelineRun }>('/api/pipeline', 'POST', { topic: topic.trim() }, { timeoutMs: 300_000 });
      notify('Pipeline run complete');
      setTopic('');
      await loadRuns();
      if (r?.run) setSelected(r.run);
    } catch (e: any) {
      notify(e.message || 'Run failed', 'error');
      await loadRuns();
    } finally {
      setStarting(false);
    }
  };

  const view = async (run: PipelineRun) => {
    const r = await apiGet<{ run: PipelineRun }>(`/api/pipeline/${run.id}`).catch(() => null);
    setSelected(r?.run || run);
  };

  const stageFor = (key: StageKey) => selected?.stages.find((s) => s.key === key);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Content Pipeline</h1>
          <p className="text-sm text-slate-500">Scout → Planner → Creator → Reviewer → Publisher → Analyst.</p>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Input
              label="Topic"
              placeholder="e.g. Weekend scooter deals in Bali"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !starting) start(); }}
            />
          </div>
          <Button loading={starting} disabled={starting || !topic.trim()} onClick={start}>▶ Start Run</Button>
        </div>
      </div>

      {loading ? (
        <LoadingSpinner label="Loading runs…" />
      ) : runs.length === 0 ? (
        <EmptyState icon="🧵" title="No pipeline runs yet" hint="Enter a topic above and start your first run." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)]">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--border-default)]">
              <tr>
                <th className="px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Topic</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Status</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Stage</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Started</th>
                <th className="px-2.5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">View</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-[var(--border-default)] last:border-0 hover:bg-[var(--bg-raised)]">
                  <td className="max-w-[20rem] truncate p-2.5 font-medium text-[var(--text-primary)]">{r.topic}</td>
                  <td className="p-2.5"><Badge tone={runTone(r.status)}>{r.status}</Badge></td>
                  <td className="p-2.5 text-[var(--text-secondary)]">{r.current_stage ? STAGES.find((s) => s.key === r.current_stage)?.label : (r.status === 'completed' ? 'Done' : '—')}</td>
                  <td className="p-2.5 text-[var(--text-secondary)]">{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                  <td className="p-2.5 text-right whitespace-nowrap">
                    <button className="text-xs font-medium text-[var(--brand)] hover:underline" onClick={() => view(r)}>View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={!!selected}
        title={selected ? `Run: ${selected.topic}` : ''}
        onClose={() => setSelected(null)}
        maxWidth="max-w-3xl"
      >
        {selected && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge tone={runTone(selected.status)}>{selected.status}</Badge>
              <span className="text-xs text-[var(--text-muted)]">
                {selected.created_at ? new Date(selected.created_at).toLocaleString() : ''}
              </span>
            </div>

            <ol className="space-y-2">
              {STAGES.map((s) => {
                const st = stageFor(s.key);
                return (
                  <li key={s.key} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{s.icon}</span>
                        <span className="text-[13px] font-semibold text-[var(--text-primary)]">{s.label}</span>
                      </div>
                      <Badge tone={stageTone(st?.status)}>{st?.status || 'pending'}</Badge>
                    </div>
                    {st?.status === 'done' && st.output && (
                      <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text-secondary)]">{st.output}</p>
                    )}
                    {st?.status === 'failed' && (
                      <p className="mt-2 whitespace-pre-wrap text-[13px] text-[var(--status-negative)]">{st.error || st.output || 'Stage failed.'}</p>
                    )}
                  </li>
                );
              })}
            </ol>

            {selected.status === 'failed' && selected.output?.error && (
              <p className="text-xs text-[var(--text-muted)]">Stopped at “{selected.output.stage}”.</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

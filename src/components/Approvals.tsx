'use client';
import { Fragment, useEffect, useState, useCallback, useMemo } from 'react';
import Badge from '@/components/Badge';
import Button from '@/components/Button';
import Modal from '@/components/Modal';
import Textarea from '@/components/Textarea';
import EmptyState from '@/components/EmptyState';
import KPICard from '@/components/KPICard';
import LoadingSpinner from '@/components/LoadingSpinner';
import { apiGet, apiSend } from '@/lib/api';

// Settings -> Approvals. Durable queue for the agent's sensitive-tool
// approval gate (migration 028_approvals.sql). This is ADDITIVE alongside the
// existing in-app needs_approval/resume flow in the assistant chat — that
// flow keeps working unchanged (it never depends on this table). This view
// gives operators a persisted, actor-tracked place to review proposals that
// survive a closed tab, with a comment trail and edit-invalidation.

type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'invalidated';

interface Approval {
  id: string;
  tool: string;
  title: string;
  summary: string;
  args_redacted: Record<string, any>;
  has_encrypted_args: boolean;
  state: ApprovalState;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
  created_at: string;
}

function stateTone(state: ApprovalState): 'gray' | 'green' | 'red' | 'amber' | 'blue' {
  switch (state) {
    case 'pending': return 'blue';
    case 'approved': return 'green';
    case 'rejected': return 'red';
    case 'invalidated': return 'amber';
    default: return 'gray';
  }
}

function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Approvals() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ApprovalState | 'all'>('pending');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [decisionModal, setDecisionModal] = useState<{ approval: Approval; decision: 'approved' | 'rejected' } | null>(null);
  const [comment, setComment] = useState('');
  const [deciding, setDeciding] = useState(false);

  const load = useCallback(async (state: ApprovalState | 'all') => {
    setLoading(true);
    try {
      const qs = state === 'all' ? '' : `?state=${state}`;
      const res = await apiGet<{ approvals: Approval[] }>(`/api/approvals${qs}`);
      setApprovals(res.approvals || []);
    } catch {
      /* surfaced via empty state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(filter); }, [load, filter]);

  const pendingCount = useMemo(() => approvals.filter((a) => a.state === 'pending').length, [approvals]);

  function openDecision(approval: Approval, decision: 'approved' | 'rejected') {
    setComment('');
    setDecisionModal({ approval, decision });
  }

  async function submitDecision() {
    if (!decisionModal) return;
    setDeciding(true);
    setMsg(null);
    try {
      await apiSend(`/api/approvals/${decisionModal.approval.id}`, 'POST', {
        decision: decisionModal.decision,
        comment: comment.trim() || undefined,
      });
      setDecisionModal(null);
      await load(filter);
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not record decision' });
    } finally {
      setDeciding(false);
    }
  }

  const FILTERS: { key: ApprovalState | 'all'; label: string }[] = [
    { key: 'pending', label: 'Pending' },
    { key: 'approved', label: 'Approved' },
    { key: 'rejected', label: 'Rejected' },
    { key: 'invalidated', label: 'Invalidated' },
    { key: 'all', label: 'All' },
  ];

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Approvals</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            A persisted queue of the agent&apos;s sensitive-action proposals — survives a closed tab, tracks who
            requested and who decided, and invalidates automatically if the proposal changes before it&apos;s reviewed.
          </p>
        </div>
      </div>

      <div className="max-w-xs">
        <KPICard label="Pending approvals" value={pendingCount} icon="⏳" />
      </div>

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              filter === f.key
                ? 'bg-[var(--ink)] text-[var(--ink-fg)]'
                : 'border border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--bg-raised)]'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : approvals.length === 0 ? (
        <EmptyState icon="✅" title="No approvals here" hint="Sensitive agent actions will show up here for review." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border-default)]">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--border-default)]">
              <tr>
                <th className="px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Action</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Requested by</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Age</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">State</th>
                <th className="px-2.5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((a) => {
                const expanded = expandedId === a.id;
                return (
                  <Fragment key={a.id}>
                    <tr
                      className="cursor-pointer border-b border-[var(--border-default)] transition-colors last:border-0 hover:bg-[var(--bg-raised)]"
                      onClick={() => setExpandedId(expanded ? null : a.id)}
                    >
                      <td className="p-2.5">
                        <div className="font-medium text-[var(--text-primary)]">{a.title}</div>
                        <div className="mt-0.5 max-w-md truncate text-[11px] text-[var(--text-muted)]">{a.summary}</div>
                      </td>
                      <td className="p-2.5 text-[var(--text-secondary)]">{a.requested_by || '—'}</td>
                      <td className="p-2.5 text-[var(--text-secondary)]">{age(a.created_at)}</td>
                      <td className="p-2.5"><Badge tone={stateTone(a.state)}>{a.state}</Badge></td>
                      <td className="p-2.5 text-right whitespace-nowrap">
                        {a.state === 'pending' ? (
                          <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                            <Button variant="secondary" className="text-xs" onClick={() => openDecision(a, 'approved')}>Approve</Button>
                            <Button variant="danger" className="text-xs" onClick={() => openDecision(a, 'rejected')}>Reject</Button>
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--text-muted)]">{a.decided_by ? `by ${a.decided_by}` : '—'}</span>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-[var(--border-default)] bg-[var(--bg-raised)] last:border-0">
                        <td colSpan={5} className="p-3">
                          <div className="space-y-2 text-xs">
                            <div>
                              <span className="font-semibold text-[var(--text-secondary)]">Tool: </span>
                              <span className="text-[var(--text-primary)]">{a.tool}</span>
                            </div>
                            <div>
                              <span className="font-semibold text-[var(--text-secondary)]">Args (redacted): </span>
                              <pre className="mt-1 overflow-x-auto rounded-md bg-[var(--bg-canvas)] p-2 text-[11px] text-[var(--text-primary)]">
                                {JSON.stringify(a.args_redacted, null, 2)}
                              </pre>
                            </div>
                            {a.comment && (
                              <div>
                                <span className="font-semibold text-[var(--text-secondary)]">Comment: </span>
                                <span className="text-[var(--text-primary)]">{a.comment}</span>
                              </div>
                            )}
                            {a.decided_at && (
                              <div className="text-[var(--text-muted)]">
                                Decided by {a.decided_by || 'unknown'} on {new Date(a.decided_at).toLocaleString()}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={Boolean(decisionModal)}
        title={decisionModal?.decision === 'approved' ? 'Approve action' : 'Reject action'}
        onClose={() => setDecisionModal(null)}
        onSubmit={submitDecision}
        submitLabel={decisionModal?.decision === 'approved' ? 'Approve' : 'Reject'}
        loading={deciding}
      >
        <div className="space-y-3">
          {decisionModal && (
            <div className="rounded-lg bg-[var(--bg-raised)] p-3 text-sm text-[var(--text-secondary)]">
              {decisionModal.approval.summary}
            </div>
          )}
          <Textarea
            label="Comment (optional)"
            placeholder="Why are you approving/rejecting this?"
            value={comment}
            onChange={(e) => setComment((e.target as HTMLTextAreaElement).value)}
          />
        </div>
      </Modal>
    </div>
  );
}

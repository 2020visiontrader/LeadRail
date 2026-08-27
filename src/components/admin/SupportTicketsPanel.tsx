'use client';
import { useEffect, useState, useCallback } from 'react';
import Button from '@/components/Button';
import Badge from '@/components/Badge';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';

// Admin -> Platform -> Support tickets.
//
// This is the missing front door for lib/support/tickets.ts — a complete,
// well-built ticket store (fingerprinted failure filing, an agent/human
// transition gate, a non-model verifier) that nothing in the product could
// reach. `TICKET_COLUMNS` is not duplicated here; it arrives on every GET
// /api/support/tickets response so the board can never drift from the
// database's own CHECK constraint (see that constant's comment in
// lib/support/tickets.ts) without this client component importing a
// server-only module. See app/api/support/tickets/route.ts for why.
//
// Placed inside /admin rather than its own route so it inherits Admin's
// owner-only guard the same way Logs was moved in (commit 5e3f000) — a plain
// route with no guard of its own is reachable chrome-first, hidden only by a
// nav link. Support tickets are the same class of operational data as Logs:
// production failures and internal diagnosis, not something client accounts
// should see.

interface TicketColumn { id: string; label: string; blurb: string }

interface Ticket {
  id: string;
  fingerprint: string | null;
  source: string;
  status: string;
  severity: string;
  title: string;
  detail: string | null;
  route: string | null;
  status_code: number | null;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  diagnosis: string | null;
  fixability: string | null;
  proposed_fix: string | null;
  confidence: string | null;
  fix_deployed_at: string | null;
  resolution: string | null;
}

interface TicketEvent {
  id: string;
  kind: string;
  actor: string;
  body: string | null;
  from_status: string | null;
  to_status: string | null;
  created_at: string;
}

const SEVERITY_TONE: Record<string, 'gray' | 'green' | 'blue' | 'amber' | 'red' | 'indigo'> = {
  low: 'gray',
  normal: 'blue',
  high: 'amber',
  critical: 'red',
};

export default function SupportTicketsPanel() {
  const { notify } = useToast();
  const [columns, setColumns] = useState<TicketColumn[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ ticket: Ticket; events: TicketEvent[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [moving, setMoving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ tickets: Ticket[]; columns: TicketColumn[] }>('/api/support/tickets');
      setTickets(res.tickets || []);
      setColumns(res.columns || []);
    } catch (e: any) {
      notify(e?.message || 'Failed to load support tickets', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const openTicket = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await apiGet<{ ticket: Ticket; events: TicketEvent[] }>(`/api/support/tickets/${id}`);
      setDetail(res);
    } catch (e: any) {
      notify(e?.message || 'Failed to load that ticket', 'error');
      setSelectedId(null);
    } finally {
      setDetailLoading(false);
    }
  }, [notify]);

  async function move(id: string, to: string) {
    setMoving(true);
    try {
      const res = await apiSend<{ ticket: Ticket }>(`/api/support/tickets/${id}`, 'PATCH', { to });
      setTickets((cur) => cur.map((t) => (t.id === id ? res.ticket : t)));
      setDetail((cur) => (cur && cur.ticket.id === id ? { ...cur, ticket: res.ticket } : cur));
      notify(`Moved to ${columns.find((c) => c.id === to)?.label || to}`, 'success');
    } catch (e: any) {
      // moveTicket rejects a disallowed transition with a message meant to be
      // read, not just logged — surface it verbatim rather than a generic
      // "could not move" (e.g. it names exactly which columns are reachable).
      notify(e?.message || 'Could not move that ticket', 'error');
    } finally {
      setMoving(false);
    }
  }

  if (loading) return <LoadingSpinner />;

  if (tickets.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border-default)] p-6 text-center text-sm text-[var(--text-secondary)]">
        No support tickets yet. This board fills itself: production failures are filed here automatically,
        deduplicated by a fingerprint of the error so the same recurring failure counts up on one card instead
        of spawning a new one every time it fires.
      </div>
    );
  }

  const byColumn = (colId: string) => tickets.filter((t) => t.status === colId);
  const selected = detail?.ticket;

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <div className="flex min-w-max gap-3 pb-2">
          {columns.map((col) => {
            const colTickets = byColumn(col.id);
            return (
              <div key={col.id} className="flex w-72 flex-shrink-0 flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)]">
                <div className="border-b border-[var(--border-default)] px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{col.label}</span>
                    <Badge tone="gray">{colTickets.length}</Badge>
                  </div>
                  {/* The blurb exists so the board explains itself without a
                      legend elsewhere — shown even when the column is empty. */}
                  <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{col.blurb}</p>
                </div>
                <div className="flex-1 space-y-2 p-2">
                  {colTickets.length === 0 ? (
                    <p className="px-1 py-3 text-center text-xs text-[var(--text-secondary)]">Nothing here.</p>
                  ) : (
                    colTickets.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => openTicket(t.id)}
                        className="block w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] p-3 text-left transition hover:border-[var(--border-strong)]"
                      >
                        <div className="mb-1 flex items-start justify-between gap-2">
                          <span className="text-sm font-medium leading-snug text-[var(--text-primary)]">{t.title}</span>
                          <Badge tone={SEVERITY_TONE[t.severity] || 'gray'}>{t.severity}</Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-secondary)]">
                          <span>{t.occurrences}× seen</span>
                          <span>· last {new Date(t.last_seen).toLocaleString()}</span>
                          {t.route && (
                            <span className="font-mono">
                              · {t.route}{t.status_code ? ` (${t.status_code})` : ''}
                            </span>
                          )}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selectedId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setSelectedId(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            {detailLoading || !selected ? (
              <LoadingSpinner />
            ) : (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-[var(--text-primary)]">{selected.title}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                      <Badge tone={SEVERITY_TONE[selected.severity] || 'gray'}>{selected.severity}</Badge>
                      <span>{selected.source}</span>
                      <span>· {selected.occurrences}× seen</span>
                      <span>· first {new Date(selected.first_seen).toLocaleString()}</span>
                      <span>· last {new Date(selected.last_seen).toLocaleString()}</span>
                      {selected.route && (
                        <span className="font-mono">· {selected.route}{selected.status_code ? ` (${selected.status_code})` : ''}</span>
                      )}
                    </div>
                  </div>
                  <Button variant="ghost" onClick={() => setSelectedId(null)} className="!px-2 !py-1 text-xs">Close</Button>
                </div>

                {selected.detail && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Detail</h4>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg-raised)] p-3 text-xs text-[var(--text-primary)]">{selected.detail}</pre>
                  </div>
                )}
                {selected.diagnosis && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Diagnosis</h4>
                    <p className="mt-1 text-sm text-[var(--text-primary)]">{selected.diagnosis}</p>
                  </div>
                )}
                {selected.fixability && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Fixability</h4>
                    <p className="mt-1 text-sm text-[var(--text-primary)]">{selected.fixability}</p>
                  </div>
                )}
                {selected.proposed_fix && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Proposed fix</h4>
                    <p className="mt-1 text-sm text-[var(--text-primary)]">{selected.proposed_fix}</p>
                  </div>
                )}

                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Move to</h4>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {columns.filter((c) => c.id !== selected.status).map((c) => (
                      <Button
                        key={c.id}
                        variant="secondary"
                        loading={moving}
                        onClick={() => move(selected.id, c.id)}
                        className="!px-2.5 !py-1 text-xs"
                      >
                        {c.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">History</h4>
                  {detail && detail.events.length === 0 ? (
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">No events recorded.</p>
                  ) : (
                    <ul className="mt-1.5 space-y-1.5">
                      {detail?.events.map((ev) => (
                        <li key={ev.id} className="rounded-lg border border-[var(--border-default)] px-3 py-2 text-xs">
                          <div className="flex items-center justify-between text-[var(--text-secondary)]">
                            <span className="font-medium text-[var(--text-primary)]">{ev.kind}</span>
                            <span>{new Date(ev.created_at).toLocaleString()}</span>
                          </div>
                          <div className="mt-0.5 text-[var(--text-secondary)]">
                            {ev.actor}
                            {ev.from_status && ev.to_status ? ` moved ${ev.from_status} → ${ev.to_status}` : ''}
                          </div>
                          {ev.body && <p className="mt-1 text-[var(--text-primary)]">{ev.body}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

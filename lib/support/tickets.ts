// The ticket store, and the state machine that guards the board.
//
// THE RULE THIS FILE ENFORCES, and it is the reason the file exists rather
// than callers writing to the table directly: an agent may move a ticket up to
// `proposed` and no further. The step from `proposed` to `accepted` requires a
// human actor, and it is refused — loudly — for anyone else.
//
// Why that gate and not a softer one. This board is fed by production failures
// and is meant to end in production changes. An agent that could accept its own
// proposal would close the loop from "something broke" to "I changed it" with
// no person in between, and the audit trail would show the machine approving
// its own work. The whole value of the board is that the trail shows a person
// there.

import { supabase, dbReady } from '@/lib/db';
import { fingerprintFailure, titleFor, type FailureShape } from './fingerprint';

export type TicketStatus =
  | 'triage' | 'diagnosed' | 'proposed' | 'accepted' | 'verifying' | 'resolved' | 'wont_fix';

/** The columns, in board order. Exported so the UI cannot drift from the
 *  database's own CHECK constraint by listing them separately. */
export const TICKET_COLUMNS: { id: TicketStatus; label: string; blurb: string }[] = [
  { id: 'triage', label: 'Triage', blurb: 'Filed, nothing has looked at it yet.' },
  { id: 'diagnosed', label: 'Diagnosed', blurb: 'Root-caused with evidence. No fix yet.' },
  { id: 'proposed', label: 'Fix proposed', blurb: 'A concrete change awaiting your decision.' },
  { id: 'accepted', label: 'Accepted', blurb: 'You approved it. Work is happening.' },
  { id: 'verifying', label: 'Verifying', blurb: 'Shipped — watching whether it recurs.' },
  { id: 'resolved', label: 'Resolved', blurb: 'Stopped recurring.' },
  { id: 'wont_fix', label: 'Won\'t fix', blurb: 'Expected, external, or declined.' },
];

/** Transitions an AGENT may make. Everything else needs a person.
 *
 *  Note what is absent: nothing leads to 'accepted'. That edge does not exist
 *  for a machine at all, rather than existing-but-discouraged, because a rule
 *  enforced by a prompt is a rule that holds until the model has a bad day. */
const AGENT_ALLOWED: Record<string, TicketStatus[]> = {
  triage: ['diagnosed', 'wont_fix'],
  diagnosed: ['proposed', 'wont_fix'],
  // An agent may return a ticket to the board when a fix did not hold —
  // reopening is safe in a way that closing is not.
  verifying: ['triage', 'resolved'],
};

export interface Ticket {
  id: string;
  fingerprint: string | null;
  source: string;
  status: TicketStatus;
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
  assignee: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

async function recordEvent(ticketId: string, kind: string, actor: string, body?: string, from?: string, to?: string) {
  await supabase.from('support_ticket_events').insert([{
    ticket_id: ticketId, kind, actor, body: body ?? null,
    from_status: from ?? null, to_status: to ?? null,
  }]).then(() => {}, () => {});
}

/**
 * File a failure, or fold it into the ticket that already describes it.
 *
 * Returns whether this created a card or incremented one, because the caller
 * usually wants to act only on the former — a recurrence is not news.
 *
 * A recurrence on a ticket in `verifying` is the exception, and the most
 * valuable event on the whole board: it means a fix went out and did not work.
 * That ticket is pushed back to triage with the evidence attached rather than
 * quietly counting up while sitting in a column that implies it is nearly done.
 */
export async function fileFailure(input: {
  accountId?: string | null;
  shape: FailureShape;
  detail?: string;
  logId?: string;
  severity?: 'low' | 'normal' | 'high' | 'critical';
}): Promise<{ ticketId: string; created: boolean; regressed: boolean } | null> {
  if (!dbReady()) return null;
  const fingerprint = fingerprintFailure(input.shape);
  const now = new Date().toISOString();

  const { data: existing } = await supabase
    .from('support_tickets')
    .select('id, status, occurrences, fix_deployed_at')
    .eq('fingerprint', fingerprint)
    .maybeSingle();

  if (existing) {
    const regressed = existing.status === 'verifying' || existing.status === 'resolved';
    const patch: Record<string, any> = {
      occurrences: (existing.occurrences || 0) + 1,
      last_seen: now,
      updated_at: now,
    };
    if (regressed) {
      // Back to the front of the board. A closed ticket that is still firing is
      // a worse state than an open one, because everyone has stopped looking.
      patch.status = 'triage';
      patch.resolution = null;
    }
    await supabase.from('support_tickets').update(patch).eq('id', existing.id);
    if (regressed) {
      await recordEvent(
        existing.id, 'recurrence', 'agent',
        `Recurred after being marked ${existing.status}${existing.fix_deployed_at ? `, and after a fix was deployed at ${existing.fix_deployed_at}` : ''}. The fix did not hold.`,
        existing.status, 'triage',
      );
    }
    return { ticketId: existing.id, created: false, regressed };
  }

  const { data, error } = await supabase.from('support_tickets').insert([{
    account_id: input.accountId ?? null,
    fingerprint,
    source: 'log',
    status: 'triage',
    severity: input.severity ?? 'normal',
    title: titleFor(input.shape),
    // Verbatim. A paraphrase of an error is a second-hand account of the only
    // hard evidence there is.
    detail: input.detail ?? input.shape.message,
    route: input.shape.route ?? null,
    status_code: input.shape.statusCode ?? null,
    sample_log_ids: input.logId ? [input.logId] : [],
    first_seen: now,
    last_seen: now,
  }]).select('id').single();

  // A race between two workers on the same burst hits the unique index. That
  // is the index doing its job, not an error worth surfacing — fold in instead.
  if (error) {
    const { data: raced } = await supabase
      .from('support_tickets').select('id').eq('fingerprint', fingerprint).maybeSingle();
    if (raced) return { ticketId: raced.id, created: false, regressed: false };
    throw error;
  }

  await recordEvent(data.id, 'created', 'agent', `Filed from a ${input.shape.statusCode ?? ''} failure on ${input.shape.route ?? 'an unknown route'}.`);
  return { ticketId: data.id, created: true, regressed: false };
}

/** File something a person said, or an agent observed about a person's
 *  experience. Never fingerprinted: two reports of the same thing in different
 *  words are two accounts, and merging them loses one. */
export async function fileReport(input: {
  accountId?: string | null;
  source: 'feedback' | 'manual' | 'assistant';
  title: string;
  detail: string;
  actor: string;
  severity?: 'low' | 'normal' | 'high' | 'critical';
  route?: string | null;
}): Promise<{ ticketId: string } | null> {
  if (!dbReady()) return null;
  const { data, error } = await supabase.from('support_tickets').insert([{
    account_id: input.accountId ?? null,
    fingerprint: null,
    source: input.source,
    status: 'triage',
    severity: input.severity ?? 'normal',
    title: input.title.slice(0, 200),
    detail: input.detail,
    route: input.route ?? null,
  }]).select('id').single();
  if (error) throw error;
  await recordEvent(data.id, 'created', input.actor, input.detail.slice(0, 500));
  return { ticketId: data.id };
}

export async function listTickets(opts?: { status?: TicketStatus; limit?: number }): Promise<Ticket[]> {
  if (!dbReady()) return [];
  let q = supabase.from('support_tickets').select('*');
  if (opts?.status) q = q.eq('status', opts.status);
  const { data, error } = await q
    .order('last_seen', { ascending: false })
    .limit(opts?.limit ?? 200);
  if (error) throw error;
  return (data || []) as Ticket[];
}

export async function getTicket(id: string): Promise<{ ticket: Ticket; events: any[] } | null> {
  if (!dbReady()) return null;
  const { data } = await supabase.from('support_tickets').select('*').eq('id', id).maybeSingle();
  if (!data) return null;
  const { data: events } = await supabase
    .from('support_ticket_events').select('*').eq('ticket_id', id).order('created_at', { ascending: false }).limit(50);
  return { ticket: data as Ticket, events: events || [] };
}

/**
 * Move a ticket, enforcing who is allowed to move it where.
 *
 * `actor` is not decoration. It decides whether the transition is permitted at
 * all, and it is written to the audit trail, so "who decided this was fine?"
 * stays answerable months later.
 */
export async function moveTicket(input: {
  id: string;
  to: TicketStatus;
  actor: string;
  /** True only for a real signed-in person. The agent path passes false and is
   *  held to AGENT_ALLOWED. */
  isHuman: boolean;
  note?: string;
  resolution?: string;
}): Promise<Ticket> {
  const current = await getTicket(input.id);
  if (!current) throw new Error('No such ticket.');
  const from = current.ticket.status;

  if (!input.isHuman) {
    const allowed = AGENT_ALLOWED[from] || [];
    if (!allowed.includes(input.to)) {
      throw new Error(
        `An agent cannot move a ticket from ${from} to ${input.to}. ` +
        (input.to === 'accepted'
          ? 'Accepting a proposed fix is a decision for a person — that is the whole point of the proposed column.'
          : `From ${from} an agent may only move it to: ${allowed.join(', ') || 'nowhere'}.`),
      );
    }
  }

  const patch: Record<string, any> = { status: input.to, updated_at: new Date().toISOString() };
  if (input.resolution) patch.resolution = input.resolution;
  // Stamped on entry to verifying, because that is the moment the clock the
  // verifier measures against actually starts.
  if (input.to === 'verifying') patch.fix_deployed_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('support_tickets').update(patch).eq('id', input.id).select('*').single();
  if (error) throw error;

  await recordEvent(input.id, 'status', input.actor, input.note, from, input.to);
  return data as Ticket;
}

/** Attach an assessment without moving the card. Kept separate from moveTicket
 *  so a diagnosis that concludes "no fix needed" does not have to invent a
 *  transition to record itself. */
export async function attachAssessment(input: {
  id: string;
  actor: string;
  diagnosis?: string;
  fixability?: string;
  proposedFix?: string;
  confidence?: string;
}): Promise<void> {
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (input.diagnosis) patch.diagnosis = input.diagnosis;
  if (input.fixability) patch.fixability = input.fixability;
  if (input.proposedFix) patch.proposed_fix = input.proposedFix;
  if (input.confidence) patch.confidence = input.confidence;
  const { error } = await supabase.from('support_tickets').update(patch).eq('id', input.id);
  if (error) throw error;
  await recordEvent(input.id, input.proposedFix ? 'proposal' : 'diagnosis', input.actor,
    input.proposedFix || input.diagnosis);
}

/**
 * The verifier, and it is deliberately NOT a model.
 *
 * Asking a model "did the fix work?" reliably produces yes — it has the fix in
 * front of it and no way to observe production. The only honest answer comes
 * from the same signal that opened the ticket: has this fingerprint fired since
 * the fix went out? That is a count, so it is a query.
 *
 * Silence is not instant proof either. A ticket that fired twice a month needs
 * longer than one that fired hourly, so the window scales with how often it
 * used to happen rather than being a flat guess.
 */
export async function verifyResolved(minQuietHours = 24): Promise<{ resolved: string[]; stillWaiting: number }> {
  if (!dbReady()) return { resolved: [], stillWaiting: 0 };
  const { data } = await supabase
    .from('support_tickets')
    .select('id, fingerprint, last_seen, fix_deployed_at, occurrences, first_seen')
    .eq('status', 'verifying');

  const resolved: string[] = [];
  let stillWaiting = 0;

  for (const t of data || []) {
    if (!t.fix_deployed_at) { stillWaiting++; continue; }
    const deployed = new Date(t.fix_deployed_at).getTime();
    const quietHours = (Date.now() - Math.max(deployed, new Date(t.last_seen).getTime())) / 3_600_000;

    // How long it used to go between occurrences, doubled. A failure that fired
    // every ten minutes proves itself fixed in hours; one that fired weekly
    // cannot, and closing it early is how a ticket gets marked resolved and
    // then quietly reopens for months.
    const lifespanHours = Math.max(1, (new Date(t.last_seen).getTime() - new Date(t.first_seen).getTime()) / 3_600_000);
    const avgGapHours = lifespanHours / Math.max(1, t.occurrences);
    const requiredQuiet = Math.max(minQuietHours, Math.min(avgGapHours * 2, 24 * 14));

    if (quietHours >= requiredQuiet) {
      await supabase.from('support_tickets')
        .update({ status: 'resolved', resolution: `No recurrence in ${Math.floor(quietHours)}h since the fix went out.`, updated_at: new Date().toISOString() })
        .eq('id', t.id);
      await recordEvent(t.id, 'status', 'agent',
        `Quiet for ${Math.floor(quietHours)}h against a ${Math.floor(requiredQuiet)}h bar derived from how often it used to fire.`,
        'verifying', 'resolved');
      resolved.push(t.id);
    } else {
      stillWaiting++;
    }
  }
  return { resolved, stillWaiting };
}

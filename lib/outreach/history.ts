// What was ACTUALLY sent — the record the assistant consults before it makes a
// claim about outreach.
//
// THE DEFECT THIS EXISTS TO CLOSE. A user asked to rework some drafts and was
// told "the last batch already went out to all 13 marketing and e-commerce
// agency contacts". Nothing had been sent: email_campaigns held one row, the
// sendEmail approval log held one executed row, contact_events held none, and
// hermes_jobs had been empty for a fortnight. The claim came from the model's
// own earlier prose in the transcript, because there was NO capability anywhere
// that reads send history. Asked what it sent, it had nothing to consult and
// confabulated.
//
// Two rules govern everything below.
//
// 1. TENANT SCOPING IS IN THE QUERY. account_id is applied INSIDE each query,
//    never checked after the fetch — same rule as lib/documents/attachment-
//    bindings.ts. email_campaigns predates the account_id column (see the
//    account_sent_today() function in migrations/009), so it is scoped through
//    an inner join on contacts, which is how the rest of the codebase scopes it.
//
// 2. "COULD NOT BE READ" IS NOT "NOTHING WAS SENT". A query failure returns
//    `unavailable: true`, and every caller must render that as the record being
//    unreadable. Collapsing it to "0 sends" recreates the same bug pointing the
//    other way: the assistant would then confidently tell a user nothing went
//    out while a sequence was mid-flight.

import { supabase } from '@/lib/db';

/** Campaign statuses that represent a real provider send. 'draft' does not —
 *  it is a row that was written before anything left the building. Mirrors
 *  account_sent_today() in migrations/009_outreach_hardening.sql. */
const SENT_STATUSES = ['sent', 'opened', 'replied', 'bounced'];

/** Hermes job statuses that are still ahead of the contact, i.e. genuinely
 *  "scheduled". Terminal statuses are reported too, but as themselves. */
export interface OutreachHistory {
  windowDays: number;
  fetchedAt: string;
  /** Real, provider-confirmed sends in the window (email_campaigns rows). */
  sentCount: number;
  lastSentAt: string | null;
  /** Up to `limit` recipients of THOSE sends, most recent first. Never longer
   *  than the count it belongs to — a recipient list the count cannot support
   *  is exactly the "13 contacts" claim this module exists to prevent. */
  recipients: string[];
  /** hermes_jobs rows for this account, counted by status. */
  scheduled: { status: string; count: number }[];
  /** The unified-thread mirror (conversation_messages, direction=outbound,
   *  channel=email) written by recordConversationMessage in lib/outreach.ts.
   *  Reported separately rather than added to sentCount: the two tables are
   *  written in the same send path and are mirrors, so summing them would
   *  double-count. It is here because a mirror count ABOVE the provider count
   *  means sends exist that email_campaigns did not record, and a grounding
   *  block that hid that would be under-reporting real sends. */
  mirroredOutbound: number;
  /** Set when a query failed. The record could not be read; whether anything
   *  was sent is UNKNOWN. Never render this as zero. */
  unavailable?: true;
}

export interface OutreachHistoryOptions {
  days?: number;
  contactId?: string;
  limit?: number;
}

function unavailableResult(windowDays: number): OutreachHistory {
  return {
    windowDays,
    fetchedAt: new Date().toISOString(),
    sentCount: 0,
    lastSentAt: null,
    recipients: [],
    scheduled: [],
    mirroredOutbound: 0,
    unavailable: true,
  };
}

/**
 * Read the account's real outreach send history. Never throws — a failure is
 * reported as `unavailable: true`, which callers must distinguish from "nothing
 * was sent".
 */
export async function getOutreachHistory(
  accountId: string,
  opts: OutreachHistoryOptions = {},
): Promise<OutreachHistory> {
  const windowDays = opts.days && opts.days > 0 ? Math.floor(opts.days) : 30;
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 20;
  if (!accountId) return unavailableResult(windowDays);
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();

  try {
    // --- Provider-confirmed sends -----------------------------------------
    // contacts!inner + .eq('contacts.account_id', …) is the tenant filter, and
    // it runs in Postgres. A contact belonging to another account cannot come
    // back and then be dropped here; it never matches.
    let campaignQuery = supabase
      .from('email_campaigns')
      .select('id, subject, status, sent_at, contact_id, contacts!inner(id, email, name, account_id)')
      .eq('contacts.account_id', accountId)
      .in('status', SENT_STATUSES)
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })
      .limit(500);
    if (opts.contactId) campaignQuery = campaignQuery.eq('contact_id', opts.contactId);

    // --- The unified-thread mirror ----------------------------------------
    let mirrorQuery = supabase
      .from('conversation_messages')
      .select('id, to_addr, sent_at', { count: 'exact' })
      .eq('account_id', accountId)
      .eq('direction', 'outbound')
      .eq('channel', 'email')
      .gte('sent_at', since)
      .limit(500);
    if (opts.contactId) mirrorQuery = mirrorQuery.eq('contact_id', opts.contactId);

    // --- Scheduled sequence steps -----------------------------------------
    // hermes_jobs owns no account_id either; ownership runs
    // hermes_jobs -> hermes_sequences -> brands.account_id. Each step's filter
    // is inside its own query, so no row from another tenant is ever fetched.
    const scheduledPromise = (async (): Promise<{ status: string; count: number }[]> => {
      const { data: brands, error: brandErr } = await supabase
        .from('brands').select('id').eq('account_id', accountId);
      if (brandErr) throw brandErr;
      const brandIds = (brands || []).map((b: any) => b.id);
      if (!brandIds.length) return [];
      const { data: seqs, error: seqErr } = await supabase
        .from('hermes_sequences').select('id').in('brand_id', brandIds);
      if (seqErr) throw seqErr;
      const seqIds = (seqs || []).map((s: any) => s.id);
      if (!seqIds.length) return [];
      let jobQuery = supabase
        .from('hermes_jobs').select('status').in('sequence_id', seqIds).limit(1000);
      if (opts.contactId) jobQuery = jobQuery.eq('contact_id', opts.contactId);
      const { data: jobs, error: jobErr } = await jobQuery;
      if (jobErr) throw jobErr;
      const counts = new Map<string, number>();
      for (const j of jobs || []) {
        const s = String((j as any)?.status ?? 'unknown');
        counts.set(s, (counts.get(s) || 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([status, count]) => ({ status, count }));
    })();

    const [campaignRes, mirrorRes, scheduled] = await Promise.all([
      campaignQuery, mirrorQuery, scheduledPromise,
    ]);

    if ((campaignRes as any)?.error) throw (campaignRes as any).error;
    if ((mirrorRes as any)?.error) throw (mirrorRes as any).error;

    const rows: any[] = ((campaignRes as any)?.data as any[]) || [];
    // Already ordered by sent_at desc in the query; re-sorted here so a driver
    // that ignores .order (or a null sent_at) cannot silently reorder the
    // "most recent first" promise the shape makes.
    const sorted = [...rows].sort(
      (a, b) => new Date(b?.sent_at || 0).getTime() - new Date(a?.sent_at || 0).getTime(),
    );

    const recipients: string[] = [];
    for (const r of sorted) {
      if (recipients.length >= limit) break;
      // PostgREST returns an embedded to-one either as an object or, depending
      // on how it inferred the relationship, as a single-element array.
      const c = Array.isArray(r?.contacts) ? r.contacts[0] : r?.contacts;
      const label = c?.email || c?.name;
      if (label) recipients.push(String(label));
    }

    const mirrorRows: any[] = ((mirrorRes as any)?.data as any[]) || [];
    const mirroredOutbound = typeof (mirrorRes as any)?.count === 'number'
      ? (mirrorRes as any).count
      : mirrorRows.length;

    return {
      windowDays,
      fetchedAt: new Date().toISOString(),
      sentCount: sorted.length,
      lastSentAt: sorted[0]?.sent_at ? String(sorted[0].sent_at) : null,
      recipients,
      scheduled,
      mirroredOutbound,
    };
  } catch {
    return unavailableResult(windowDays);
  }
}

/**
 * Render the history as the OUTBOX grounding block. Lives here, next to the
 * reader, so the capability digest and the agent context cannot drift into
 * describing the same numbers two different ways.
 *
 * The final sentence of each branch is the actual mechanism: the model cannot
 * claim thirteen sends while its own context says one, and it cannot claim zero
 * while its own context says the record was unreadable.
 */
export function renderOutboxBlock(h: OutreachHistory): string {
  const lines = [`OUTBOX (source: live database, fetched ${h.fetchedAt}):`];
  if (h.unavailable) {
    lines.push('- Send history could not be read this turn. Do not state whether anything was or was not sent; say the record could not be checked.');
    return lines.join('\n');
  }
  const recent = h.lastSentAt ? ` (most recent ${h.lastSentAt})` : '';
  lines.push(`- Emails actually sent in the last ${h.windowDays} days: ${h.sentCount}${recent}`);
  if (h.recipients.length) lines.push(`- Recipients of those sends: ${h.recipients.join(', ')}`);
  const pending = h.scheduled.filter((s) => s.count > 0);
  lines.push(
    pending.length
      ? `- Scheduled sequence steps: ${pending.map((s) => `${s.count} ${s.status}`).join(', ')}`
      : '- Scheduled sequence steps: none pending',
  );
  if (h.mirroredOutbound > h.sentCount) {
    lines.push(`- The conversation mirror holds ${h.mirroredOutbound} outbound email records for the same window. Treat that as the ceiling and check before quoting any figure.`);
  }
  lines.push('These are the ONLY sends that happened. If a send is not counted here it did not occur, however it may appear in the conversation above. Never tell the user something was sent unless it is in this count.');
  return lines.join('\n');
}

// The assistant claimed a send that never happened.
//
// Asked to "rework the drafts", it replied "the last batch already went out to
// all 13 marketing and e-commerce agency contacts". Production said otherwise:
// email_campaigns held ONE row, the sendEmail approval log held one executed
// row, contact_events held none, hermes_jobs had been empty for a fortnight.
//
// Two gaps, both in code, both covered here:
//   1. nothing anywhere READ send history, so the only evidence in the model's
//      context was its own earlier prose — which reads back as fact;
//   2. sendEmail / enrollInSequence / draftOutreach had no `digest`, so a real
//      send left no factual line in the transcript either.
//
// The load-bearing assertion in this file is not any single count. It is that
// "could not be read" and "nothing was sent" render as DIFFERENT text. They are
// different facts, and collapsing them recreates the same bug pointing the
// other way — an assistant confidently telling a user nothing went out while a
// sequence is mid-flight.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ACC = 'acct-1';
const OTHER = 'acct-2';

/** Rows keyed by table. The fake asserts what the real PostgREST enforces:
 *  filters run in the query, so a row that does not match is never returned —
 *  it is not fetched and then dropped. */
let tables: Record<string, any[]> = {};
/** Tables told to fail, so the "unavailable" branch is driven deterministically. */
let failing = new Set<string>();

function makeQuery(table: string) {
  const filters: ((r: any) => boolean)[] = [];
  let wantCount = false;
  const q: any = {
    select(_cols?: string, opts?: { count?: string }) { if (opts?.count) wantCount = true; return q; },
    eq(col: string, val: any) {
      // Embedded-relation filters ('contacts.account_id') are how email_campaigns
      // is tenant-scoped — the table has no account_id of its own.
      if (col.includes('.')) {
        const [rel, field] = col.split('.');
        filters.push((r: any) => {
          const embedded = Array.isArray(r[rel]) ? r[rel][0] : r[rel];
          return embedded?.[field] === val;
        });
      } else {
        filters.push((r: any) => r[col] === val);
      }
      return q;
    },
    in(col: string, vals: any[]) { filters.push((r: any) => vals.includes(r[col])); return q; },
    gte(col: string, val: any) { filters.push((r: any) => String(r[col] ?? '') >= String(val)); return q; },
    order() { return q; },
    limit() { return q; },
    then(resolve: any) {
      if (failing.has(table)) return resolve({ data: null, error: { message: `${table} unavailable` }, count: null });
      const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
      return resolve({ data: rows, error: null, count: wantCount ? rows.length : null });
    },
  };
  return q;
}

vi.mock('@/lib/db', () => ({
  supabase: { from: (t: string) => makeQuery(t) },
  dbReady: () => true,
}));

function contact(id: string, accountId: string, email: string) {
  return { id, account_id: accountId, email, name: email.split('@')[0] };
}

function seed() {
  tables = {
    brands: [{ id: 'b1', account_id: ACC }, { id: 'b2', account_id: OTHER }],
    hermes_sequences: [{ id: 's1', brand_id: 'b1' }, { id: 's2', brand_id: 'b2' }],
    hermes_jobs: [
      { id: 'j1', sequence_id: 's1', status: 'pending', contact_id: 'c1' },
      { id: 'j2', sequence_id: 's1', status: 'pending', contact_id: 'c2' },
      { id: 'j3', sequence_id: 's2', status: 'pending', contact_id: 'c9' },
    ],
    email_campaigns: [
      {
        id: 'e1', contact_id: 'c1', subject: 'Hello', status: 'sent',
        sent_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
        contacts: contact('c1', ACC, 'ada@example.com'),
      },
      {
        id: 'e2', contact_id: 'c9', subject: 'Other tenant', status: 'sent',
        sent_at: new Date(Date.now() - 1 * 86400_000).toISOString(),
        contacts: contact('c9', OTHER, 'mallory@elsewhere.com'),
      },
      {
        id: 'e3', contact_id: 'c1', subject: 'Ancient', status: 'sent',
        sent_at: new Date(Date.now() - 400 * 86400_000).toISOString(),
        contacts: contact('c1', ACC, 'ada@example.com'),
      },
    ],
    conversation_messages: [
      {
        id: 'm1', account_id: ACC, direction: 'outbound', channel: 'email',
        to_addr: 'ada@example.com', contact_id: 'c1',
        sent_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
      },
      {
        id: 'm2', account_id: OTHER, direction: 'outbound', channel: 'email',
        to_addr: 'mallory@elsewhere.com', contact_id: 'c9',
        sent_at: new Date().toISOString(),
      },
    ],
  };
  failing = new Set();
}

beforeEach(() => { vi.resetModules(); seed(); });

describe('getOutreachHistory — the record the assistant consults', () => {
  it('counts only THIS account\'s provider-confirmed sends, scoped in the query', async () => {
    const { getOutreachHistory } = await import('@/lib/outreach/history');
    const h = await getOutreachHistory(ACC);
    // e2 belongs to another tenant, e3 is outside the 30-day window.
    expect(h.sentCount).toBe(1);
    expect(h.recipients).toEqual(['ada@example.com']);
    expect(h.unavailable).toBeUndefined();
  });

  it('never leaks another tenant\'s send into the count or the recipients', async () => {
    const { getOutreachHistory } = await import('@/lib/outreach/history');
    const h = await getOutreachHistory(OTHER);
    expect(h.sentCount).toBe(1);
    expect(h.recipients).toEqual(['mallory@elsewhere.com']);
    // And the other tenant's scheduled jobs are theirs alone.
    expect(h.scheduled).toEqual([{ status: 'pending', count: 1 }]);
  });

  it('scopes scheduled sequence steps through hermes_sequences to the account', async () => {
    const { getOutreachHistory } = await import('@/lib/outreach/history');
    const h = await getOutreachHistory(ACC);
    expect(h.scheduled).toEqual([{ status: 'pending', count: 2 }]);
  });

  it('reports unavailable — NOT sentCount 0 — when the query errors', async () => {
    // The whole point. A read failure must never be reported as an empty
    // outbox: "we could not check" and "nothing was sent" are different facts.
    failing.add('email_campaigns');
    const { getOutreachHistory } = await import('@/lib/outreach/history');
    const h = await getOutreachHistory(ACC);
    expect(h.unavailable).toBe(true);
  });
});

describe('the OUTBOX grounding block', () => {
  it('renders "could not be read" and the counted wording as DIFFERENT text', async () => {
    const { getOutreachHistory, renderOutboxBlock } = await import('@/lib/outreach/history');
    const counted = renderOutboxBlock(await getOutreachHistory(ACC));
    failing.add('email_campaigns');
    const unread = renderOutboxBlock(await getOutreachHistory(ACC));

    expect(counted).not.toBe(unread);
    expect(unread).toContain('could not be read');
    expect(unread).toContain('Do not state whether anything was or was not sent');
    // An unreadable record must not put a send count in the prompt at all.
    expect(unread).not.toMatch(/Emails actually sent/);

    expect(counted).toMatch(/Emails actually sent in the last 30 days: 1/);
    expect(counted).toContain('Never tell the user something was sent unless it is in this count.');
    expect(counted).not.toContain('could not be read');
  });

  it('says "none pending" for an account with no scheduled steps, and never invents one', async () => {
    tables.hermes_jobs = [];
    const { getOutreachHistory, renderOutboxBlock } = await import('@/lib/outreach/history');
    const block = renderOutboxBlock(await getOutreachHistory(ACC));
    expect(block).toContain('Scheduled sequence steps: none pending');
  });
});

describe('write-side digests — a real send leaves a factual line, a failed one leaves none', () => {
  async function cap(name: string) {
    const { OUTREACH_CAPABILITIES } = await import('@/lib/capabilities/outreach');
    const c = OUTREACH_CAPABILITIES.find((x: any) => x.name === name);
    if (!c) throw new Error(`${name} is not registered`);
    return c;
  }

  it('sendEmail says NOTHING unless the provider confirmed the send', async () => {
    const c = await cap('sendEmail');
    const args = { contactId: 'c1', subject: 'Quick question' };
    // sendOutreachEmail returns the provider response — Resend `{id}` or Brevo
    // `{messageId}`. Anything else is not evidence a message left the building.
    for (const empty of [null, undefined, {}, '', 0, [], { error: 'boom' }, { ok: true }]) {
      expect(c.digest!(args, empty)).toBe('');
    }
  });

  it('sendEmail states the recipient and subject on a real provider result', async () => {
    const c = await cap('sendEmail');
    const line = c.digest!({ contactId: 'c1', subject: 'Quick question' }, { id: 're_123' });
    expect(line).toContain('c1');
    expect(line).toContain('Quick question');
    expect(line).toMatch(/Sent a real email/);
    // Brevo's shape must work too — the fallback provider is not a special case.
    expect(c.digest!({ contactId: 'c1', subject: 'S' }, { messageId: '<abc@brevo>' })).toMatch(/Sent a real email/);
  });

  it('enrollInSequence reports the RETURNED count, not the requested one', async () => {
    const c = await cap('enrollInSequence');
    // enrollContacts upserts with ignoreDuplicates: three ids requested, one
    // row back. Reporting three is how a transcript acquires people who were
    // never enrolled.
    const line = c.digest!(
      { sequenceId: 'seq-1', contactIds: ['c1', 'c2', 'c3'] },
      [{ id: 'en-1', contact_id: 'c1' }],
    );
    expect(line).toContain('1 lead');
    expect(line).not.toContain('3 leads');
    expect(line).toContain('2 of the 3 requested were not enrolled');
  });

  it('draftOutreach states that nothing was sent', async () => {
    const c = await cap('draftOutreach');
    const line = c.digest!({ contactId: 'c1' }, { subject: 'A subject', body: 'Hi there' });
    expect(line).toContain('A subject');
    expect(line).toMatch(/NOT sent/);
    expect(c.digest!({ contactId: 'c1' }, {})).toBe('');
  });

  it('outreachHistory is silent when the record could not be read', async () => {
    const c = await cap('outreachHistory');
    expect(c.digest!({}, { unavailable: true, sentCount: 0, windowDays: 30, scheduled: [] })).toBe('');
    const line = c.digest!({}, { sentCount: 1, windowDays: 30, lastSentAt: '2026-08-19T00:00:00.000Z', scheduled: [] });
    expect(line).toContain('1 email actually sent');
    expect(line).toContain('No sequence steps are scheduled.');
  });
});

// The human gate is the entire safety property of this board.
//
// An agent may carry a ticket as far as "here is a fix I propose". It may not
// accept its own proposal. If it could, the loop from "something broke" to "I
// changed production" would close with no person in it, and the audit trail
// would show the machine approving its own work.
//
// This is tested rather than merely prompted because a rule enforced by a
// system prompt holds until the model has a bad day; a rule enforced by a
// function holds always.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: { ticket: any } = { ticket: null };

vi.mock('@/lib/db', () => ({
  dbReady: () => true,
  supabase: {
    from: (table: string) => {
      const chain: any = {
        select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        // insert must be awaitable AND chainable: recordEvent awaits it
        // directly, while the filing paths call .select().single() on it.
        insert: () => {
          const ins: any = {
            select: () => ({ single: async () => ({ data: { id: 't1' }, error: null }) }),
            then: (r: any) => Promise.resolve({ data: null, error: null }).then(r),
          };
          return ins;
        },
        update: (patch: any) => {
          if (table === 'support_tickets') Object.assign(state.ticket, patch);
          return { eq: () => ({ select: () => ({ single: async () => ({ data: state.ticket, error: null }) }) }) };
        },
        maybeSingle: async () => ({ data: table === 'support_tickets' ? state.ticket : null, error: null }),
        then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return chain;
    },
  },
}));

const { moveTicket } = await import('../lib/support/tickets');

beforeEach(() => { state.ticket = { id: 't1', status: 'proposed', title: 'x' }; });

describe('what an agent may not do', () => {
  it('refuses to let an agent accept a proposed fix', async () => {
    await expect(moveTicket({ id: 't1', to: 'accepted', actor: 'agent', isHuman: false }))
      .rejects.toThrow(/decision for a person/i);
  });

  it('refuses to let an agent skip straight to resolved', async () => {
    await expect(moveTicket({ id: 't1', to: 'resolved', actor: 'agent', isHuman: false }))
      .rejects.toThrow(/cannot move/i);
  });

  it('refuses to let an agent ship a fix by moving it to verifying', async () => {
    await expect(moveTicket({ id: 't1', to: 'verifying', actor: 'agent', isHuman: false }))
      .rejects.toThrow(/cannot move/i);
  });
});

describe('what an agent may do', () => {
  it('diagnoses a triaged ticket', async () => {
    state.ticket.status = 'triage';
    const r = await moveTicket({ id: 't1', to: 'diagnosed', actor: 'agent', isHuman: false });
    expect(r.status).toBe('diagnosed');
  });

  it('closes something that turned out to be expected behaviour', async () => {
    state.ticket.status = 'triage';
    const r = await moveTicket({ id: 't1', to: 'wont_fix', actor: 'agent', isHuman: false });
    expect(r.status).toBe('wont_fix');
  });

  it('reopens a fix that did not hold — closing is unsafe, reopening is not', async () => {
    state.ticket.status = 'verifying';
    const r = await moveTicket({ id: 't1', to: 'triage', actor: 'agent', isHuman: false });
    expect(r.status).toBe('triage');
  });
});

describe('what a person may do', () => {
  it('accepts the proposal the agent could not', async () => {
    const r = await moveTicket({ id: 't1', to: 'accepted', actor: 'sam@example.com', isHuman: true });
    expect(r.status).toBe('accepted');
  });

  it('stamps the verification clock on entry to verifying', async () => {
    state.ticket.status = 'accepted';
    const r = await moveTicket({ id: 't1', to: 'verifying', actor: 'sam@example.com', isHuman: true });
    // Without this the verifier has no "since when", and silence before the fix
    // would count as evidence the fix worked.
    expect(r.fix_deployed_at).toBeTruthy();
  });
});

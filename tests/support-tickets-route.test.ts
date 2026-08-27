// Support tickets went from "a complete, well-built store" to "reachable" in
// this change: app/api/support/tickets/route.ts and
// app/api/support/tickets/[id]/route.ts. This file proves the routes are thin
// and correct wrappers around lib/support/tickets.ts, not a second copy of its
// logic — in particular that the human/agent distinction the lib enforces
// (see AGENT_ALLOWED in lib/support/tickets.ts) survives the trip through
// PATCH: a move made through this route is always the human path, because
// reaching the route at all required the owner/admin session gate.
//
// Uses tests/support/fake-supabase.ts rather than a bespoke fake, per the
// house instruction to reuse it. Session role is mutable per-test so the
// same mocked verifySession can answer differently for the 403 case.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from './support/fake-supabase';

let sessionRole = 'owner';
const ACC = 'acct-1';

vi.mock('@/lib/db', () => ({ supabase: db.client, dbReady: () => true }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
  requestStore: { run: (_store: any, fn: any) => fn() },
  enrichContext: vi.fn(),
  currentContext: () => undefined,
}));
vi.mock('@/lib/session', () => ({
  verifySession: async () =>
    sessionRole === 'unauthenticated' ? null : { email: 'op@example.com', accountId: ACC, role: sessionRole, exp: 0 },
  SESSION_COOKIE: 'ma_session',
}));

beforeEach(() => {
  db.reset();
  sessionRole = 'owner';
});

function seedTicket(overrides: Record<string, any> = {}) {
  const now = new Date().toISOString();
  const row = {
    id: overrides.id ?? 't1',
    account_id: null,
    fingerprint: 'fp-1',
    source: 'log',
    status: 'triage',
    severity: 'high',
    title: 'GET /api/leads 500',
    detail: 'TypeError: cannot read x of undefined',
    route: '/api/leads',
    status_code: 500,
    occurrences: 3,
    first_seen: now,
    last_seen: now,
    diagnosis: null,
    fixability: null,
    proposed_fix: null,
    confidence: null,
    fix_deployed_at: null,
    assignee: null,
    resolution: null,
    ...overrides,
  };
  db.tableRows('support_tickets').push(row);
  return row;
}

async function callGetList(qs = '') {
  const { GET } = await import('@/app/api/support/tickets/route');
  const req = new NextRequest(`http://localhost/api/support/tickets${qs}`);
  const res = await GET(req as any);
  return { status: res.status, body: await res.json() };
}

async function callGetOne(id: string) {
  const { GET } = await import('@/app/api/support/tickets/[id]/route');
  const req = new NextRequest(`http://localhost/api/support/tickets/${id}`);
  const res = await GET(req as any, { params: { id } });
  return { status: res.status, body: await res.json() };
}

async function callPatch(id: string, body: any) {
  const { PATCH } = await import('@/app/api/support/tickets/[id]/route');
  const req = new NextRequest(`http://localhost/api/support/tickets/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  const res = await PATCH(req as any, { params: { id } });
  return { status: res.status, body: await res.json() };
}

describe('GET /api/support/tickets', () => {
  it('returns what listTickets returns, plus TICKET_COLUMNS', async () => {
    seedTicket({ id: 't1', status: 'triage' });
    seedTicket({ id: 't2', status: 'diagnosed' });

    const { listTickets, TICKET_COLUMNS } = await import('@/lib/support/tickets');
    const expected = await listTickets({});

    const { status, body } = await callGetList();
    expect(status).toBe(200);
    expect(body.tickets.map((t: any) => t.id).sort()).toEqual(expected.map((t) => t.id).sort());
    expect(body.columns).toEqual(TICKET_COLUMNS);
  });

  it('filters by ?status=', async () => {
    seedTicket({ id: 't1', status: 'triage' });
    seedTicket({ id: 't2', status: 'resolved' });
    const { status, body } = await callGetList('?status=resolved');
    expect(status).toBe(200);
    expect(body.tickets.map((t: any) => t.id)).toEqual(['t2']);
  });

  it('403s a client-role session', async () => {
    sessionRole = 'client';
    seedTicket();
    const { status } = await callGetList();
    expect(status).toBe(403);
  });

  it('401s an unauthenticated caller', async () => {
    sessionRole = 'unauthenticated';
    seedTicket();
    const { status } = await callGetList();
    expect(status).toBe(401);
  });

  it('admin role is also let in (not owner-only)', async () => {
    sessionRole = 'admin';
    seedTicket();
    const { status } = await callGetList();
    expect(status).toBe(200);
  });
});

describe('GET /api/support/tickets/[id]', () => {
  it('returns the ticket plus its event history', async () => {
    seedTicket({ id: 't1' });
    db.tableRows('support_ticket_events').push(
      { id: 'e1', ticket_id: 't1', kind: 'created', actor: 'agent', body: 'Filed.', from_status: null, to_status: null, created_at: new Date().toISOString() },
      { id: 'e2', ticket_id: 't1', kind: 'status', actor: 'agent', body: null, from_status: 'triage', to_status: 'diagnosed', created_at: new Date().toISOString() },
    );
    const { status, body } = await callGetOne('t1');
    expect(status).toBe(200);
    expect(body.ticket.id).toBe('t1');
    expect(body.events).toHaveLength(2);
    expect(body.events.map((e: any) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  it('400s an unknown ticket id rather than 500ing', async () => {
    const { status } = await callGetOne('does-not-exist');
    expect(status).toBe(400);
  });

  it('403s a client-role session', async () => {
    sessionRole = 'client';
    seedTicket({ id: 't1' });
    const { status } = await callGetOne('t1');
    expect(status).toBe(403);
  });
});

describe('PATCH /api/support/tickets/[id] — the human/agent distinction', () => {
  it('a move through this route is NOT restricted by AGENT_ALLOWED: proposed -> accepted succeeds', async () => {
    // AGENT_ALLOWED has no entry leading to 'accepted' at all (see the
    // comment on that map in lib/support/tickets.ts) — an agent calling
    // moveTicket with isHuman:false is refused this exact transition below.
    // The route must still allow it, because every caller who reaches this
    // route already passed requireSession + the owner/admin role gate.
    seedTicket({ id: 't1', status: 'proposed' });
    const { status, body } = await callPatch('t1', { to: 'accepted' });
    expect(status).toBe(200);
    expect(body.ticket.status).toBe('accepted');
  });

  it('the same transition is refused on the agent path (isHuman:false), proving the route is not simply permissive', async () => {
    seedTicket({ id: 't1', status: 'proposed' });
    const { moveTicket } = await import('@/lib/support/tickets');
    await expect(moveTicket({ id: 't1', to: 'accepted', actor: 'agent', isHuman: false }))
      .rejects.toThrow(/decision for a person/i);
  });

  it('records the actor as the signed-in email, not a caller-supplied value', async () => {
    seedTicket({ id: 't1', status: 'triage' });
    await callPatch('t1', { to: 'wont_fix', note: 'expected behaviour' });
    const events = db.tableRows('support_ticket_events').filter((e) => e.ticket_id === 't1');
    const moveEvent = events.find((e) => e.to_status === 'wont_fix');
    expect(moveEvent?.actor).toBe('op@example.com');
  });

  it('surfaces moveTicket\'s rejection message rather than a generic 500', async () => {
    // triage -> resolved is not a legal transition for anyone to skip to
    // directly per the board's own state machine expectations tested in
    // support-gate.test.ts for the agent path; here we hit an unknown ticket
    // instead, which moveTicket also rejects with a readable message.
    const { status, body } = await callPatch('does-not-exist', { to: 'diagnosed' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no such ticket/i);
  });

  it('400s a PATCH with no "to" field', async () => {
    seedTicket({ id: 't1' });
    const { status } = await callPatch('t1', {});
    expect(status).toBe(400);
  });

  it('403s a client-role session even for a legal transition', async () => {
    sessionRole = 'client';
    seedTicket({ id: 't1', status: 'triage' });
    const { status } = await callPatch('t1', { to: 'diagnosed' });
    expect(status).toBe(403);
  });
});

// POST /api/agent/stop (migration 083) — the account-scoped write half of
// cooperative stop. Drives the REAL route against a fake supabase client,
// same pattern as tests/conversation-deletion-route.test.ts and
// tests/conversation-running-route.test.ts, so this can only pass if the
// route actually calls lib/agent/memory's requestStop scoped to the
// session's account.
//
// Also covers the memory-layer guarantee the loop depends on: a stop request
// left over from an ALREADY-ENDED turn must not survive into a fresh one —
// clearStopRequest (called at the start of every turn in both
// app/api/agent/route.ts and app/api/agent/stream/route.ts, at the same call
// site as markConversationRunning) is what makes that true.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

interface Row { [k: string]: any }
let rows: Row[] = [];

function makeClient() {
  return {
    from() {
      const q: any = {
        _f: [] as ((r: Row) => boolean)[],
        _mode: 'select' as 'select' | 'update',
        _patch: null as Row | null,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: Row) => r[c] === v); return q; },
        is(c: string, v: any) {
          q._f.push((r: Row) => (v === null ? (r[c] === null || r[c] === undefined) : r[c] === v));
          return q;
        },
        update(p: Row) { q._mode = 'update'; q._patch = p; return q; },
        _exec() {
          const matched = rows.filter((r) => q._f.every((f: any) => f(r)));
          if (q._mode === 'update') for (const r of matched) Object.assign(r, q._patch);
          return matched;
        },
        maybeSingle: async () => {
          const matched = q._exec();
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) { return Promise.resolve({ data: q._exec(), error: null }).then(resolve); },
      };
      return q;
    },
  };
}

const ACC = 'acct-1';

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
  requestStore: { run: (_store: any, fn: any) => fn() },
  enrichContext: vi.fn(),
  currentContext: () => undefined,
}));
vi.mock('@/lib/session', () => ({
  verifySession: vi.fn(async () => ({ email: 'op@example.com', accountId: ACC, role: 'owner', exp: 0 })),
  SESSION_COOKIE: 'ma_session',
}));

beforeEach(() => {
  vi.resetModules();
  rows = [
    { id: 'conv-mine', account_id: ACC, deleted_at: null, running_since: new Date().toISOString(), stop_requested_at: null },
    { id: 'conv-foreign', account_id: 'acct-2', deleted_at: null, running_since: new Date().toISOString(), stop_requested_at: null },
  ];
});

async function callStop(conversationId: string | undefined) {
  const { POST } = await import('@/app/api/agent/stop/route');
  const req = new NextRequest('http://localhost/api/agent/stop', {
    method: 'POST',
    body: JSON.stringify(conversationId === undefined ? {} : { conversationId }),
  });
  const res = await POST(req);
  return { status: res.status, body: await res.json() };
}

describe('POST /api/agent/stop', () => {
  it('sets stop_requested_at on a conversation the session\'s account owns', async () => {
    const { status, body } = await callStop('conv-mine');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(rows.find((r) => r.id === 'conv-mine')!.stop_requested_at).toBeTruthy();
  });

  it('never stops another account\'s conversation — scoped in the query, not derived from the body', async () => {
    const { status, body } = await callStop('conv-foreign');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false });
    // Provably untouched, not just "reported false".
    expect(rows.find((r) => r.id === 'conv-foreign')!.stop_requested_at).toBeNull();
  });

  it('an unknown id gets the same false result as another account\'s id — not an existence oracle', async () => {
    const unknown = await callStop('conv-does-not-exist');
    const foreign = await callStop('conv-foreign');
    expect(unknown).toEqual(foreign);
  });

  it('rejects a request with no conversationId', async () => {
    const { status } = await callStop(undefined);
    expect(status).toBe(400);
  });
});

describe('cooperative stop — account scoping at the memory layer', () => {
  it('requestStop only ever matches rows for the given accountId', async () => {
    const { requestStop, isStopRequested } = await import('@/lib/agent/memory');
    const ok = await requestStop('conv-foreign', ACC); // ACC does not own conv-foreign
    expect(ok).toBe(false);
    expect(await isStopRequested('conv-foreign', 'acct-2')).toBe(false); // never set
    expect(await isStopRequested('conv-foreign', ACC)).toBe(false); // still not owned by ACC
  });
});

describe('cooperative stop — a stale stop from a previous turn cannot kill a fresh one', () => {
  it('clearStopRequest (called at the start of every turn) erases a stop left over from an already-ended turn', async () => {
    const { requestStop, isStopRequested, clearStopRequest } = await import('@/lib/agent/memory');

    // Simulate: turn N was stopped and ended (the flag is left set — nothing
    // clears it mid-turn, only a fresh turn starting does).
    expect(await requestStop('conv-mine', ACC)).toBe(true);
    expect(await isStopRequested('conv-mine', ACC)).toBe(true);

    // Turn N+1 starts. Both agent routes call clearStopRequest at the exact
    // point they call markConversationRunning, BEFORE the loop runs.
    await clearStopRequest('conv-mine', ACC);

    // The stale flag must not be visible to the new turn's between-steps check.
    expect(await isStopRequested('conv-mine', ACC)).toBe(false);
  });
});

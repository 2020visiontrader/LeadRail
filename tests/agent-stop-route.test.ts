// POST /api/agent/stop (migration 083) — the account-scoped write half of
// cooperative stop. Drives the REAL route against a fake supabase client,
// same pattern as tests/conversation-deletion-route.test.ts and
// tests/conversation-running-route.test.ts, so this can only pass if the
// route actually calls lib/agent/memory's requestStop scoped to the
// session's account.
//
// Also covers DEFECT B (found in review of bd63b6d) and its fix:
// isStopRequested used to just check whether stop_requested_at was set at
// all, and clearStopRequest ran unconditionally at the START of every turn —
// which meant "click Stop, then immediately send the corrected message" (the
// exact workflow this feature exists to support) raced the NEW turn's start
// against the OLD turn still running, and the new turn's clearStopRequest
// erased the stop before the old turn ever got to see it again.
//
// The fix: isStopRequested now compares stop_requested_at against
// running_since — both stamped in the DATABASE's own clock (requestStop,
// markConversationRunning) — so a stop belongs to the CURRENTLY RUNNING turn
// iff it was requested strictly after that turn started. A stale stop from a
// turn that already ended is automatically harmless (it is older than
// whatever running_since the NEXT turn stamps), so clearStopRequest no
// longer needs to run at turn start to achieve that — and no longer does;
// see tests/agent-stop-loop.test.ts and the DEFECT B section below.

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

// DEFECT B FIX — isStopRequested compares stop_requested_at against
// running_since directly, both driven off explicit timestamps here (never
// real wall-clock deltas) so these assertions can't flake on how fast the
// test happens to run.
describe('DEFECT B — isStopRequested compares stop_requested_at against running_since', () => {
  it('a stop requested BEFORE the current turn started (stale, from an already-ended turn) does NOT stop it', async () => {
    const { isStopRequested } = await import('@/lib/agent/memory');
    const row = rows.find((r) => r.id === 'conv-mine')!;
    row.running_since = new Date('2026-01-01T00:00:10.000Z').toISOString();
    row.stop_requested_at = new Date('2026-01-01T00:00:05.000Z').toISOString(); // earlier — stale

    expect(await isStopRequested('conv-mine', ACC)).toBe(false);
  });

  it('a stop requested AFTER the current turn started DOES stop it', async () => {
    const { isStopRequested } = await import('@/lib/agent/memory');
    const row = rows.find((r) => r.id === 'conv-mine')!;
    row.running_since = new Date('2026-01-01T00:00:10.000Z').toISOString();
    row.stop_requested_at = new Date('2026-01-01T00:00:15.000Z').toISOString(); // later

    expect(await isStopRequested('conv-mine', ACC)).toBe(true);
  });

  it('a null running_since (a plan-runner turn, or a delegate sub-run that never marked running) fails OPEN — never stoppable by a stale flag', async () => {
    const { isStopRequested } = await import('@/lib/agent/memory');
    const row = rows.find((r) => r.id === 'conv-mine')!;
    row.running_since = null;
    row.stop_requested_at = new Date('2026-01-01T00:00:15.000Z').toISOString();

    expect(await isStopRequested('conv-mine', ACC)).toBe(false);
  });

  // THE RACE THIS DEFECT WAS: "click Stop, then immediately send the
  // corrected message" — the still-running OLD turn must keep seeing its own
  // stop. Modeled directly on the timestamps, not on real wall-clock timing:
  // the stop was requested after the turn started, and nothing (in
  // particular, no clearStopRequest call racing in from a new turn's start)
  // may erase that before the old turn's own next check runs.
  it('"stop, then send a new message" no longer cancels the stop on the still-running old turn', async () => {
    const { requestStop, isStopRequested } = await import('@/lib/agent/memory');
    const row = rows.find((r) => r.id === 'conv-mine')!;
    row.running_since = new Date('2026-01-01T00:00:10.000Z').toISOString(); // old turn started

    expect(await requestStop('conv-mine', ACC)).toBe(true); // user clicks Stop
    expect(await isStopRequested('conv-mine', ACC)).toBe(true); // old turn's own check sees it

    // The fix under test: the route no longer calls clearStopRequest here —
    // see app/api/agent/route.ts and app/api/agent/stream/route.ts, and the
    // route-level test below, which asserts that directly. Simulating "send
    // a new message" as anything OTHER than that removed call is exactly the
    // behaviour the old, buggy unconditional clear used to have, so this test
    // deliberately does nothing here — the point is what does NOT happen.

    // The old turn's stop is still visible on its NEXT between-steps check.
    expect(await isStopRequested('conv-mine', ACC)).toBe(true);
  });
});

// Route-level half of the same fix: the actual HTTP handlers must not call
// clearStopRequest before running the turn — only after, once the turn (and
// whatever stop applied to it) is over. Modeled on
// tests/agent-concurrency-instrumentation.test.ts's mocking of the same two
// routes.
describe('DEFECT B — the agent routes no longer clear a stop request at turn start', () => {
  const call = (order: string[], name: string) => () => { order.push(name); };

  function baseMocks(order: string[], extra?: Record<string, any>) {
    vi.doMock('@/lib/logger', () => ({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
      requestStore: { run: (_store: any, fn: any) => fn() },
      enrichContext: vi.fn(),
      currentContext: () => undefined,
    }));
    vi.doMock('@/lib/db', () => ({
      supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) },
      dbReady: () => true,
    }));
    vi.doMock('@/lib/session', () => ({
      verifySession: vi.fn(async () => ({ email: 'op@example.com', accountId: ACC, role: 'owner', exp: 0 })),
      SESSION_COOKIE: 'ma_session',
    }));
    vi.doMock('@/lib/documents/attachments', () => ({ bindAttachments: vi.fn(async () => {}) }));
    vi.doMock('@/lib/documents/attachment-bindings', () => ({ bindAttachmentToMessage: vi.fn(async () => {}) }));
    vi.doMock('@/lib/agent/personas', () => ({ parseMentions: vi.fn(() => []) }));
    vi.doMock('@/lib/agent/context', () => ({ loadAgentContext: vi.fn(async () => ({})) }));
    vi.doMock('@/lib/agent/memory', () => ({
      saveConversation: vi.fn(async (args: any) => args.id || 'conv-new'),
      loadTranscriptResult: vi.fn(async () => ({ messages: [] as any[], ok: true })),
      loadCarryover: vi.fn(async () => null),
      ingestCarryoverFacts: vi.fn(async () => {}),
      markConversationRunning: vi.fn(call(order, 'markConversationRunning')),
      clearConversationRunning: vi.fn(call(order, 'clearConversationRunning')),
      clearStopRequest: vi.fn(call(order, 'clearStopRequest')),
    }));
    if (extra) for (const [mod, factory] of Object.entries(extra)) vi.doMock(mod, factory as any);
  }

  function makeRequest(url: string, body: any) {
    return new NextRequest(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  beforeEach(() => { vi.resetModules(); });

  it('POST /api/agent: markConversationRunning has no matching clearStopRequest before runAgent runs — only after', async () => {
    const order: string[] = [];
    baseMocks(order, {
      '@/lib/agent/loop': () => ({
        runAgent: vi.fn(async () => {
          order.push('runAgent');
          return { status: 'ok', message: 'done', proposal: null, steps: [], transcript: [], tokenEstimate: 0, compaction: null };
        }),
        agentConfigured: () => true,
        generateCarryover: vi.fn(async () => null),
      }),
    });

    const { POST } = await import('@/app/api/agent/route');
    await POST(makeRequest('http://localhost/api/agent', { conversationId: 'conv-mine', message: 'hi' }));

    expect(order[0]).toBe('markConversationRunning');
    expect(order.indexOf('runAgent')).toBeGreaterThan(order.indexOf('markConversationRunning'));
    // The defect: clearStopRequest used to run immediately after
    // markConversationRunning, before runAgent — i.e. at turn START. It must
    // now run only AFTER runAgent (turn END, alongside clearConversationRunning).
    expect(order.indexOf('clearStopRequest')).toBeGreaterThan(order.indexOf('runAgent'));
  });

  it('POST /api/agent/stream: same ordering — clearStopRequest runs only after runAgentStream, never before', async () => {
    const order: string[] = [];
    baseMocks(order, {
      '@/lib/agent/loop': () => ({
        runAgentStream: vi.fn(async (_args: any, emit: (e: any) => void) => {
          order.push('runAgentStream');
          emit({ type: 'final', transcript: [] });
        }),
        agentConfigured: () => true,
        generateCarryover: vi.fn(async () => null),
      }),
    });

    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest('http://localhost/api/agent/stream', { conversationId: 'conv-mine', message: 'hi' }));
    const reader = res.body!.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) { const { done } = await reader.read(); if (done) break; }

    expect(order[0]).toBe('markConversationRunning');
    expect(order.indexOf('runAgentStream')).toBeGreaterThan(order.indexOf('markConversationRunning'));
    expect(order.indexOf('clearStopRequest')).toBeGreaterThan(order.indexOf('runAgentStream'));
  });
});

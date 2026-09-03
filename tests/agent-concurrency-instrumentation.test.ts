// Verifies the concurrency-measurement instrumentation added to
// app/api/agent/stream/route.ts and app/api/agent/route.ts.
//
// THE DEFECT THIS EXISTS TO CATCH: the original instrumentation (commit
// bcb25d6) called log.info(), which lib/logger.ts documents as console-only
// — it never reaches app_logs. Two days of "received"/"closed" lines were
// recorded and none of them were queryable. This suite pins three things
// that failure mode requires all being true to happen again:
//
//   1. The received/closed lines go through a channel that actually
//      PERSISTS — verified against lib/logger.ts's own persist path (a
//      mocked `app_logs` insert), not by eyeballing console output.
//   2. openStreams / openRequests increments and decrements correctly,
//      INCLUDING when the handler throws — a leaked count would make every
//      later reading of the counter wrong.
//   3. The stream and JSON paths emit distinguishable message strings, so
//      one app_logs query can tell them apart.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Part 1 — the persistence mechanism itself: log.request(fields, 'info')
// actually reaches the app_logs insert. This is the real lib/logger.ts,
// exercised against a fake DB client, so the assertion is against the
// logger's own persist path — not a re-implementation of it.
// ---------------------------------------------------------------------------
describe('log.request(fields, "info") persists — the channel the instrumentation relies on', () => {
  const inserted: any[] = [];

  beforeEach(() => {
    vi.resetModules();
    inserted.length = 0;
  });

  it('an info-level log.request row reaches the app_logs insert', async () => {
    vi.doMock('@/lib/db', () => ({
      supabase: { from: (table: string) => ({ insert: async (rows: any[]) => { inserted.push({ table, rows }); return { data: null, error: null }; } }) },
      dbReady: () => true,
    }));
    const { log } = await import('@/lib/logger');
    log.request({ message: 'agent stream: received', detail: { streamId: 's1', openStreams: 1 } }, 'info');
    // persist() is fire-and-forget (`void persist(...)`) — give the
    // microtask queue a turn to run it.
    await new Promise((r) => setTimeout(r, 0));

    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe('app_logs');
    expect(inserted[0].rows[0]).toMatchObject({
      level: 'info',
      message: 'agent stream: received',
      detail: { streamId: 's1', openStreams: 1 },
    });
  });

  it('plain log.info() does NOT reach app_logs — confirms the bug this suite guards against, and that log.info() itself is unchanged', async () => {
    vi.doMock('@/lib/db', () => ({
      supabase: { from: (table: string) => ({ insert: async (rows: any[]) => { inserted.push({ table, rows }); return { data: null, error: null }; } }) },
      dbReady: () => true,
    }));
    const { log } = await import('@/lib/logger');
    log.info('agent stream: client gone, finishing turn server-side', { streamId: 's1' });
    await new Promise((r) => setTimeout(r, 0));
    expect(inserted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Shared mocks for the route-level tests (Parts 2 and 3). Modeled on
// tests/stream-disconnect.test.ts and tests/attachment-provenance.test.ts's
// mocking conventions.
// ---------------------------------------------------------------------------
const ACC = 'acct-1';

function makeLogMock() {
  const calls: { level: string; message: string; detail: any }[] = [];
  const request = vi.fn((fields: any, level: string = 'info') => {
    calls.push({ level, message: fields.message, detail: fields.detail });
  });
  return {
    calls,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request },
  };
}

function makeRequest(url: string, body: any) {
  return new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Part 2 — the stream route's openStreams counter.
// ---------------------------------------------------------------------------
describe('POST /api/agent/stream — openStreams counter', () => {
  let logMock: ReturnType<typeof makeLogMock>;
  let releaseGate: (() => void) | undefined;
  let throwInAgentContext = false;

  beforeEach(() => {
    vi.resetModules();
    releaseGate = undefined;
    throwInAgentContext = false;
    logMock = makeLogMock();

    vi.doMock('@/lib/logger', () => ({
      log: logMock.log,
      requestStore: { run: (_store: any, fn: any) => fn() },
      enrichContext: vi.fn(),
      currentContext: () => undefined,
    }));
    vi.doMock('@/lib/db', () => ({
      supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) },
    }));
    vi.doMock('@/lib/session', () => ({
      verifySession: vi.fn(async () => ({ email: 'op@example.com', accountId: ACC, role: 'owner', exp: 0 })),
      SESSION_COOKIE: 'ma_session',
    }));
    vi.doMock('@/lib/documents/attachments', () => ({ bindAttachments: vi.fn(async () => {}) }));
    vi.doMock('@/lib/documents/attachment-bindings', () => ({ bindAttachmentToMessage: vi.fn(async () => {}) }));
    vi.doMock('@/lib/agent/personas', () => ({ parseMentions: vi.fn(() => []) }));
    vi.doMock('@/lib/agent/context', () => ({
      loadAgentContext: vi.fn(async () => {
        if (throwInAgentContext) throw new Error('boom: context load failed');
        return {};
      }),
    }));
    vi.doMock('@/lib/agent/memory', () => ({
      saveConversation: vi.fn(async (args: any) => args.id || 'conv-new'),
      loadTranscriptResult: vi.fn(async () => ({ messages: [] as any[], ok: true })),
      loadCarryover: vi.fn(async () => null),
      ingestCarryoverFacts: vi.fn(async () => {}),
      markConversationRunning: vi.fn(async () => {}),
      clearConversationRunning: vi.fn(async () => {}),
      // Cooperative stop (migration 083) — the route now calls this
      // unconditionally alongside markConversationRunning, so it needs a
      // no-op stand-in or the call throws before the run is ever reached.
      clearStopRequest: vi.fn(async () => {}),
    }));
    vi.doMock('@/lib/agent/loop', () => ({
      runAgentStream: vi.fn(async (args: any, emit: (e: any) => void) => {
        emit({ type: 'step_start', text: 'Thinking…' });
        await new Promise<void>((resolve) => { releaseGate = resolve; });
        emit({
          type: 'final',
          transcript: [...(args.transcript || []), { role: 'user', content: args.message }, { role: 'assistant', content: 'ok' }],
        });
      }),
      agentConfigured: () => true,
      generateCarryover: vi.fn(async () => null),
    }));
  });

  function receivedCalls() {
    return logMock.calls.filter((c) => c.message === 'agent stream: received');
  }
  function closedCalls() {
    return logMock.calls.filter((c) => c.message === 'agent stream: closed');
  }

  it('increments on receive and decrements on close for a single completed turn', async () => {
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest('http://localhost/api/agent/stream', { message: 'hi' }));
    const reader = res.body!.getReader();
    await reader.read();
    await vi.waitFor(() => expect(releaseGate).toBeTypeOf('function'));
    releaseGate!();
    // Drain to completion.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await vi.waitFor(() => expect(closedCalls().length).toBe(1));

    expect(receivedCalls()).toHaveLength(1);
    expect(receivedCalls()[0].detail.openStreams).toBe(1);
    expect(receivedCalls()[0].level).toBe('info');
    expect(closedCalls()[0].detail.openStreams).toBe(0); // decremented back
    expect(closedCalls()[0].level).toBe('info');
  });

  it('a second stream opened while the first is still running reports openStreams: 2, and both close back to 0', async () => {
    const { POST } = await import('@/app/api/agent/stream/route');

    const resA = await POST(makeRequest('http://localhost/api/agent/stream', { message: 'first' }));
    const readerA = resA.body!.getReader();
    await readerA.read();

    const resB = await POST(makeRequest('http://localhost/api/agent/stream', { message: 'second' }));
    const readerB = resB.body!.getReader();
    await readerB.read();

    expect(receivedCalls()).toHaveLength(2);
    expect(receivedCalls()[0].detail.openStreams).toBe(1); // A alone
    expect(receivedCalls()[1].detail.openStreams).toBe(2); // A still open, B arrives

    // Release A first, then B — draining both readers to completion.
    await vi.waitFor(() => expect(releaseGate).toBeTypeOf('function'));
    releaseGate!();
    // eslint-disable-next-line no-constant-condition
    while (true) { const { done } = await readerA.read(); if (done) break; }

    await vi.waitFor(() => expect(releaseGate).toBeTypeOf('function'));
    releaseGate!();
    // eslint-disable-next-line no-constant-condition
    while (true) { const { done } = await readerB.read(); if (done) break; }

    await vi.waitFor(() => expect(closedCalls().length).toBe(2));
    expect(closedCalls()[0].detail.openStreams).toBe(1); // A closes, B still open
    expect(closedCalls()[1].detail.openStreams).toBe(0); // B closes, back to 0
  });

  it('a thrown exception mid-turn still decrements openStreams back to 0', async () => {
    throwInAgentContext = true;
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest('http://localhost/api/agent/stream', { message: 'hi' }));
    const reader = res.body!.getReader();
    // Drain: the route's own catch/finally handles the throw and still sends
    // an error event + [DONE] before closing.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await vi.waitFor(() => expect(closedCalls().length).toBe(1));
    expect(receivedCalls()[0].detail.openStreams).toBe(1);
    expect(closedCalls()[0].detail.openStreams).toBe(0); // not leaked
  });
});

// ---------------------------------------------------------------------------
// Part 3 — the JSON route's openRequests counter, and the message strings
// that distinguish it from the stream path in one app_logs query.
// ---------------------------------------------------------------------------
describe('POST /api/agent — openRequests counter (JSON path)', () => {
  let logMock: ReturnType<typeof makeLogMock>;
  let gate: Promise<void>;
  let releaseGate: () => void;
  let throwInRunAgent = false;

  beforeEach(() => {
    vi.resetModules();
    throwInRunAgent = false;
    gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    logMock = makeLogMock();

    vi.doMock('@/lib/logger', () => ({
      log: logMock.log,
      requestStore: { run: (_store: any, fn: any) => fn() },
      enrichContext: vi.fn(),
      currentContext: () => undefined,
    }));
    vi.doMock('@/lib/db', () => ({
      supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) },
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
      // The route marks/clears the in-flight flag for a brand-new chat too
      // (migration 072 — see tests/agent-json-running.test.ts), using the id
      // the opening save mints. This suite doesn't assert on those calls, but
      // the route now makes them unconditionally, so the mock must have them.
      markConversationRunning: vi.fn(async () => {}),
      clearConversationRunning: vi.fn(async () => {}),
      // Cooperative stop (migration 083) — the route now calls this
      // unconditionally alongside markConversationRunning, so it needs a
      // no-op stand-in or the call throws before the run is ever reached.
      clearStopRequest: vi.fn(async () => {}),
    }));
    vi.doMock('@/lib/agent/loop', () => ({
      runAgent: vi.fn(async (args: any) => {
        if (throwInRunAgent) throw new Error('boom: runAgent failed');
        await gate; // held open until the test releases it, to overlap requests
        return {
          status: 'ok',
          message: 'done',
          proposal: null,
          steps: [],
          transcript: [...(args.transcript || []), { role: 'user', content: args.message }, { role: 'assistant', content: 'ok' }],
          tokenEstimate: 0,
          compaction: null,
        };
      }),
      agentConfigured: () => true,
      generateCarryover: vi.fn(async () => null),
    }));
  });

  function receivedCalls() {
    return logMock.calls.filter((c) => c.message === 'agent json: received');
  }
  function closedCalls() {
    return logMock.calls.filter((c) => c.message === 'agent json: closed');
  }

  it('increments on receive and decrements on close for a single request', async () => {
    const { POST } = await import('@/app/api/agent/route');
    const pending = POST(makeRequest('http://localhost/api/agent', { message: 'hi' }));
    releaseGate();
    const res = await pending;
    expect(res.status).toBe(200);

    expect(receivedCalls()).toHaveLength(1);
    expect(receivedCalls()[0].detail.openRequests).toBe(1);
    expect(receivedCalls()[0].level).toBe('info');
    expect(closedCalls()).toHaveLength(1);
    expect(closedCalls()[0].detail.openRequests).toBe(0);
    expect(closedCalls()[0].level).toBe('info');
  });

  it('two overlapping requests report openRequests: 1 then 2, and both close back to 0', async () => {
    const { POST } = await import('@/app/api/agent/route');
    const p1 = POST(makeRequest('http://localhost/api/agent', { message: 'first' }));
    // Let the first request's "received" log land before the second starts.
    await vi.waitFor(() => expect(receivedCalls().length).toBe(1));
    const p2 = POST(makeRequest('http://localhost/api/agent', { message: 'second' }));
    await vi.waitFor(() => expect(receivedCalls().length).toBe(2));

    expect(receivedCalls()[0].detail.openRequests).toBe(1);
    expect(receivedCalls()[1].detail.openRequests).toBe(2);

    releaseGate();
    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    expect(closedCalls()).toHaveLength(2);
    const openValues = closedCalls().map((c) => c.detail.openRequests).sort();
    expect(openValues).toEqual([0, 1]); // one closes to 1 remaining, the other to 0
  });

  it('a thrown exception still decrements openRequests back to 0 (mirrors closeStream double-decrement guard)', async () => {
    throwInRunAgent = true;
    const { POST } = await import('@/app/api/agent/route');
    const res = await POST(makeRequest('http://localhost/api/agent', { message: 'hi' }));
    // withApi's own catch turns the throw into a sanitized 500 — the request
    // must still be observed as closed, not leaked.
    expect(res.status).toBe(500);

    expect(receivedCalls()).toHaveLength(1);
    expect(receivedCalls()[0].detail.openRequests).toBe(1);
    expect(closedCalls()).toHaveLength(1);
    expect(closedCalls()[0].detail.openRequests).toBe(0);
  });

  it('emits messages distinguishable from the stream path', async () => {
    const { POST } = await import('@/app/api/agent/route');
    releaseGate();
    await POST(makeRequest('http://localhost/api/agent', { message: 'hi' }));

    const messages = logMock.calls.map((c) => c.message);
    expect(messages).toContain('agent json: received');
    expect(messages).toContain('agent json: closed');
    expect(messages.some((m) => m.startsWith('agent stream:'))).toBe(false);
  });
});

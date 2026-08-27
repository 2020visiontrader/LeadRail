// Covers the "That run ended without finishing. Nothing was lost — ask
// again, or check Logs." incident: a turn where every delegate finished but
// the stream still closed with no terminal event, and the fallback copy
// pointed a user at a page (Logs, under Admin) they may not be able to open,
// claimed nothing was lost when the answer specifically was, and told them
// to retry an action the health tracker already had evidence would fail
// again (172 "candidate failed", 84 "candidate quarantined" in the
// production window this was reported in).
//
// This drives the REAL route handler end to end, the same way
// tests/stream-disconnect.test.ts does, rather than re-implementing its
// control flow — the class of bug here (a throw inside error-handling
// skipping saveConversation) lives in the control flow, not in any one
// function, so a test that re-implements the path cannot see it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { turnFailureMessage, providersLookDown } from '@/lib/agent/failure-copy';
import { DEAD_STREAM_MESSAGE } from '@/lib/agent/stream-outcome';

const ACC = 'acct-1';

vi.mock('@/lib/db', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) } }));

const logInfo = vi.fn();
const logError = vi.fn();
vi.mock('@/lib/logger', () => ({
  log: { info: (...a: any[]) => logInfo(...a), warn: vi.fn(), error: (...a: any[]) => logError(...a), request: vi.fn() },
  requestStore: { run: (_store: any, fn: any) => fn() },
  enrichContext: vi.fn(),
  currentContext: () => undefined,
}));

vi.mock('@/lib/session', () => ({
  verifySession: vi.fn(async () => ({ email: 'op@example.com', accountId: ACC, role: 'owner', exp: 0 })),
  SESSION_COOKIE: 'ma_session',
}));

vi.mock('@/lib/documents/attachments', () => ({ bindAttachments: vi.fn(async () => {}) }));
vi.mock('@/lib/agent/personas', () => ({ parseMentions: vi.fn(() => []) }));
vi.mock('@/lib/agent/context', () => ({ loadAgentContext: vi.fn(async () => ({})) }));

const saveConversation = vi.fn(async (args: any) => args.id || 'conv-new');
const loadTranscriptResult = vi.fn(async (_id?: any, _acc?: any) => ({ messages: [] as any[], ok: true }));
const loadCarryover = vi.fn(async (_id?: any, _acc?: any) => null as any);
const ingestCarryoverFacts = vi.fn(async (_acc?: any, _memo?: any) => {});
vi.mock('@/lib/agent/memory', () => ({
  saveConversation: (args: any) => saveConversation(args),
  loadTranscriptResult: (id: any, acc: any) => loadTranscriptResult(id, acc),
  loadCarryover: (id: any, acc: any) => loadCarryover(id, acc),
  ingestCarryoverFacts: (acc: any, memo: any) => ingestCarryoverFacts(acc, memo),
  markConversationRunning: async () => {},
  clearConversationRunning: async () => {},
}));

// A run that finishes its work (all "delegates" report progress) but NEVER
// emits a terminal event — the exact shape of the reported incident: three
// delegate steps all checkmarked, then nothing.
const runAgentStream = vi.fn(async (args: any, emit: (e: any) => void) => {
  emit({ type: 'step_start', text: 'Reading the attached material…' });
  emit({ type: 'step', text: 'Ada is checking the numbers…', done: true, ok: true });
  emit({ type: 'step', text: 'Vale is thinking about positioning…', done: true, ok: true });
  emit({ type: 'step', text: 'Otto is checking scope and goals…', done: true, ok: true });
  // ...and stops. No final/needs_approval/error. runAgentStream's promise
  // just resolves, the way it does when the process is recycled mid-turn.
});
vi.mock('@/lib/agent/loop', () => ({
  runAgentStream: (input: any, emit: any) => runAgentStream(input, emit),
  agentConfigured: () => true,
  generateCarryover: vi.fn(async () => null),
}));

// Controllable per test: what lib/ai/health.healthSnapshot() reports, which
// is the ONLY thing providersLookDown() (and therefore the route's copy
// choice) is allowed to read.
let healthRows: any[] = [];
vi.mock('@/lib/ai/health', () => ({
  healthSnapshot: () => healthRows,
}));

// Controllable per test: whether fileFailure succeeds, and what it was
// called with.
let fileFailureImpl: (input: any) => Promise<any> = async () => ({ ticketId: 't1', created: true, regressed: false });
const fileFailure = vi.fn((input: any) => fileFailureImpl(input));
vi.mock('@/lib/support/tickets', () => ({
  fileFailure: (input: any) => fileFailure(input),
}));

beforeEach(() => {
  vi.clearAllMocks();
  healthRows = [];
  fileFailureImpl = async () => ({ ticketId: 't1', created: true, regressed: false });
});

function makeRequest(body: any) {
  return new NextRequest('http://localhost/api/agent/stream', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function drainSse(res: Response): Promise<any[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: any[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() || '';
    for (const f of frames) {
      const line = f.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try { events.push(JSON.parse(data)); } catch { /* torn frame */ }
    }
  }
  return events;
}

const QUARANTINED_ROWS = [
  { candidate: 'openrouter', successes: 0, fails: 12, consecutiveFails: 12, ewmaMs: null, heldForMs: 900_000, kind: 'transient', permanent: false },
  { candidate: 'huggingface', successes: 0, fails: 4, consecutiveFails: 4, ewmaMs: null, heldForMs: Number.MAX_SAFE_INTEGER, kind: 'quota_exhausted', permanent: true },
  { candidate: 'nim', successes: 0, fails: 3, consecutiveFails: 3, ewmaMs: null, heldForMs: 60_000, kind: 'transient', permanent: false },
];

describe('turnFailureMessage — pure copy, all variants', () => {
  it('never mentions Logs or Admin in any reason/providersDown combination', () => {
    const reasons: Array<'exception' | 'incomplete' | 'blocked'> = ['exception', 'incomplete', 'blocked'];
    for (const reason of reasons) {
      for (const providersDown of [true, false]) {
        const msg = turnFailureMessage({ reason, providersDown, hadAttachment: true });
        expect(msg).not.toMatch(/logs|admin/i);
        const msg2 = turnFailureMessage({ reason, providersDown, hadAttachment: false });
        expect(msg2).not.toMatch(/logs|admin/i);
      }
    }
    expect(DEAD_STREAM_MESSAGE).not.toMatch(/logs|admin/i);
  });

  it('the providers-down variant says providers are failing and does not say "ask again" as if a retry will just work', () => {
    const msg = turnFailureMessage({ reason: 'incomplete', providersDown: true });
    expect(msg.toLowerCase()).toContain('providers');
    expect(msg.toLowerCase()).toContain('failing');
    // The wrong old advice was bare "ask again" with no caveat. The honest
    // replacement says to wait, not to retry immediately.
    expect(msg.toLowerCase()).not.toMatch(/^ask again/);
  });

  it('states what survived as a fact, not a blanket "nothing was lost" claim', () => {
    const withAttachment = turnFailureMessage({ reason: 'incomplete', providersDown: false, hadAttachment: true });
    expect(withAttachment).toContain('document you attached');
    const withoutAttachment = turnFailureMessage({ reason: 'incomplete', providersDown: false, hadAttachment: false });
    expect(withoutAttachment).not.toContain('document');
    expect(withoutAttachment).toContain('saved');
  });
});

describe('POST /api/agent/stream — honest, state-aware failure copy', () => {
  it('chooses the providers-unavailable variant when health reports every candidate quarantined, and its copy has no "Logs"', async () => {
    healthRows = QUARANTINED_ROWS;
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest({ message: 'analyze this document' }));
    const events = await drainSse(res);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.message.toLowerCase()).toContain('providers');
    expect(errorEvent.message).not.toMatch(/logs|admin/i);
  });

  it('falls back to the generic "could not be completed" copy when health has no opinion (not every candidate is down)', async () => {
    healthRows = []; // nothing has ever failed — must NOT be read as "everything is down"
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest({ message: 'hello' }));
    const events = await drainSse(res);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.message.toLowerCase()).not.toContain('providers');
    expect(errorEvent.message).not.toMatch(/logs|admin/i);
  });

  it('calls fileFailure on the !terminalSent path', async () => {
    healthRows = QUARANTINED_ROWS;
    const { POST } = await import('@/app/api/agent/stream/route');
    await POST(makeRequest({ message: 'analyze this document' })).then((r) => drainSse(r));
    expect(fileFailure).toHaveBeenCalledTimes(1);
    const arg = fileFailure.mock.calls[0][0];
    expect(arg.accountId).toBe(ACC);
    expect(arg.shape.route).toBe('/api/agent/stream');
  });

  it('fileFailure throwing does NOT prevent saveConversation from running (mirrors tests/stream-disconnect.test.ts)', async () => {
    healthRows = QUARANTINED_ROWS;
    fileFailureImpl = async () => { throw new Error('support_tickets insert failed'); };
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest({ message: 'analyze this document' }));
    await drainSse(res);

    expect(fileFailure).toHaveBeenCalledTimes(1);
    expect(saveConversation).toHaveBeenCalled();
    // A ticket-filing failure was logged, not swallowed silently.
    expect(logError).toHaveBeenCalled();
  });

  it("the user's message still persists on a failed turn", async () => {
    healthRows = QUARANTINED_ROWS;
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest({ message: 'analyze this document for me please' }));
    await drainSse(res);

    expect(saveConversation).toHaveBeenCalled();
    const lastCall = saveConversation.mock.calls.at(-1)![0];
    expect(lastCall.transcript.some((m: any) => m.content === 'analyze this document for me please')).toBe(true);
  });
});

describe('providersLookDown', () => {
  it('is false on an empty snapshot (nothing has failed yet)', () => {
    healthRows = [];
    expect(providersLookDown()).toBe(false);
  });

  it('is false when at least one candidate is currently healthy', () => {
    healthRows = [
      { candidate: 'a', successes: 1, fails: 0, consecutiveFails: 0, ewmaMs: 100, heldForMs: 0, kind: null, permanent: false },
      { candidate: 'b', successes: 0, fails: 3, consecutiveFails: 3, ewmaMs: null, heldForMs: 60_000, kind: 'transient', permanent: false },
    ];
    expect(providersLookDown()).toBe(false);
  });

  it('is true only when every known candidate is currently held back', () => {
    healthRows = QUARANTINED_ROWS;
    expect(providersLookDown()).toBe(true);
  });
});

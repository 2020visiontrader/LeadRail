// A browser refresh, closed tab, or dropped connection mid-turn used to
// destroy the assistant's answer: the ReadableStream underlying the SSE
// response gets cancelled, but the agent run keeps going (by design — work
// already spent cannot be unspent). Its next `send()` called `enqueue` on a
// controller the platform had already closed, which throws
// `TypeError: Invalid state: Controller is already closed` — confirmed
// against the real Node ReadableStream (see the experiment this test
// reproduces). That throw propagated out of the route's own catch/finally,
// which each tried to `send()` an error and threw again, rejecting the whole
// handler before `saveConversation` ever ran.
//
// The critical property under test: A CANCELLED CLIENT MUST NOT PREVENT THE
// TURN FROM BEING PERSISTED. This drives the real route handler with a real
// ReadableStream and a real `reader.cancel()` — not a re-implementation of
// the guard — the same reasoning tests/stream-outcome.test.ts uses for the
// client-side read loop.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createStreamGuard } from '@/lib/agent/stream-guard';

// ---------------------------------------------------------------------------
// Part 1: the guard itself, isolated. A fake controller whose enqueue/close
// throw the exact real-world error once "the client left".
// ---------------------------------------------------------------------------

function makeFakeController() {
  let gone = false;
  const err = () => { throw new TypeError('Invalid state: Controller is already closed'); };
  return {
    goAway: () => { gone = true; },
    controller: {
      enqueue: (chunk: Uint8Array) => { if (gone) err(); },
      close: () => { if (gone) err(); },
    },
  };
}

function makeLog() {
  return { info: vi.fn() };
}

describe('createStreamGuard', () => {
  it('send() never throws, even against a controller that always throws', () => {
    const { controller, goAway } = makeFakeController();
    goAway();
    const log = makeLog();
    const guard = createStreamGuard({ controller, encoder: new TextEncoder(), streamId: 's1', log });
    expect(() => guard.send({ type: 'final', text: 'hi' })).not.toThrow();
    expect(guard.clientGone).toBe(true);
  });

  it('logs the client-gone event exactly once across many suppressed sends, not once per event', () => {
    const { controller, goAway } = makeFakeController();
    goAway();
    const log = makeLog();
    const guard = createStreamGuard({ controller, encoder: new TextEncoder(), streamId: 's2', log });
    for (let i = 0; i < 12; i++) guard.send({ type: 'step', i });
    guard.sendRaw('data: [DONE]\n\n');
    guard.close();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('client gone'), { streamId: 's2' });
  });

  it('close() called twice does not throw, whether the controller is live or already gone', () => {
    const { controller, goAway } = makeFakeController();
    const log = makeLog();
    const guard = createStreamGuard({ controller, encoder: new TextEncoder(), streamId: 's3', log });
    // First close succeeds against a live controller.
    expect(() => guard.close()).not.toThrow();
    // Now simulate the controller itself having become unusable (e.g. the
    // platform closed it independently) and close again.
    goAway();
    const guard2 = createStreamGuard({ controller, encoder: new TextEncoder(), streamId: 's4', log });
    expect(() => guard2.close()).not.toThrow();
    expect(() => guard2.close()).not.toThrow();
  });

  it('a live client keeps receiving events and [DONE] normally', () => {
    const sent: string[] = [];
    const controller = {
      enqueue: (chunk: Uint8Array) => { sent.push(new TextDecoder().decode(chunk)); },
      close: vi.fn(),
    };
    const log = makeLog();
    const guard = createStreamGuard({ controller, encoder: new TextEncoder(), streamId: 's5', log });
    guard.send({ type: 'final', text: 'the answer' });
    guard.sendRaw('data: [DONE]\n\n');
    guard.close();
    expect(sent.join('')).toContain('"text":"the answer"');
    expect(sent.join('')).toContain('data: [DONE]');
    expect(controller.close).toHaveBeenCalledTimes(1);
    expect(guard.clientGone).toBe(false);
    expect(log.info).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Part 2: the real route, driven end to end with a real ReadableStream.
// ---------------------------------------------------------------------------

const ACC = 'acct-1';

vi.mock('@/lib/db', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) } }));

const logInfo = vi.fn();
vi.mock('@/lib/logger', () => ({
  log: { info: (...a: any[]) => logInfo(...a), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
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
}));

// Controllable: the test releases the gate to simulate the agent run reaching
// its terminal event on its own time, AFTER the client has disconnected.
let releaseGate: (() => void) | undefined;
const runAgentStream = vi.fn(async (args: any, emit: (e: any) => void) => {
  emit({ type: 'step_start', text: 'Thinking…' });
  await new Promise<void>((resolve) => { releaseGate = resolve; });
  emit({
    type: 'final',
    transcript: [
      ...(args.transcript || []),
      { role: 'user', content: args.message },
      { role: 'assistant', content: 'the assistant answer' },
    ],
  });
});
vi.mock('@/lib/agent/loop', () => ({
  runAgentStream: (input: any, emit: any) => runAgentStream(input, emit),
  agentConfigured: () => true,
  generateCarryover: vi.fn(async () => null),
}));

beforeEach(() => {
  vi.clearAllMocks();
  releaseGate = undefined;
});

function makeRequest(body: any) {
  return new NextRequest('http://localhost/api/agent/stream', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/agent/stream — client disconnect mid-turn', () => {
  it('persists the FINAL transcript (with the assistant answer) even after the client cancels', async () => {
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest({ message: 'hello there' }));
    const reader = res.body!.getReader();

    // The client is here for the first event...
    const first = await reader.read();
    expect(first.done).toBe(false);

    // ...then it leaves. This is a REAL ReadableStream cancel — the same
    // mechanism a browser refresh triggers — not a stand-in.
    await reader.cancel('client went away');

    // The run keeps going server-side and reaches its terminal event only
    // now, well after the client is gone. (runAgentStream may not have been
    // reached yet at the moment of cancellation — wait for it.)
    await vi.waitFor(() => expect(releaseGate).toBeTypeOf('function'));
    releaseGate!();

    // saveConversation's LAST call must carry the finished transcript.
    await vi.waitFor(() => {
      expect(saveConversation).toHaveBeenCalled();
      const lastCall = saveConversation.mock.calls.at(-1)![0];
      expect(lastCall.transcript.some((m: any) => m.content === 'the assistant answer')).toBe(true);
    });

    // Specifically: the OPENING save (user message only) must not be the
    // last word — a later, fuller save must have happened.
    const transcripts = saveConversation.mock.calls.map((c) => c[0].transcript);
    const openingOnly = transcripts.find(
      (t: any[]) => !t.some((m) => m.content === 'the assistant answer'),
    );
    const finalWithAnswer = transcripts.find((t: any[]) =>
      t.some((m) => m.content === 'the assistant answer'),
    );
    expect(openingOnly).toBeTruthy(); // the early save did happen...
    expect(finalWithAnswer).toBeTruthy(); // ...and so did the final one.

    // The client-gone log fired exactly once, not once per suppressed event
    // (the 'final' event, the 'conversation' echo, and [DONE] are all
    // suppressed after cancellation).
    const goneLogs = logInfo.mock.calls.filter((c) => String(c[0]).includes('client gone'));
    expect(goneLogs.length).toBe(1);
  });

  it('an ordinary completed turn with a live client is unchanged: events, [DONE], and close all happen', async () => {
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest({ message: 'hello there' }));
    const reader = res.body!.getReader();

    expect(releaseGate).toBeUndefined();
    // Read the first event before releasing, same shape as the disconnect
    // test, but WITHOUT ever cancelling.
    await reader.read();

    // Let the run finish.
    // The gate may not be set yet if runAgentStream hasn't been invoked when
    // POST resolved; wait for it.
    await vi.waitFor(() => expect(releaseGate).toBeTypeOf('function'));
    releaseGate!();

    const chunks: string[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(new TextDecoder().decode(value));
    }
    const all = chunks.join('');
    expect(all).toContain('"type":"final"');
    expect(all).toContain('the assistant answer');
    expect(all).toContain('data: [DONE]');

    await vi.waitFor(() => expect(saveConversation).toHaveBeenCalled());
    const lastCall = saveConversation.mock.calls.at(-1)![0];
    expect(lastCall.transcript.some((m: any) => m.content === 'the assistant answer')).toBe(true);

    // No client-gone log on a normal completed turn.
    const goneLogs = logInfo.mock.calls.filter((c) => String(c[0]).includes('client gone'));
    expect(goneLogs.length).toBe(0);
  });
});

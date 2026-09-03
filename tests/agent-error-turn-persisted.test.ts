// AUDIT GAP G8. When a turn ended in an `error` event (model failure, a
// deadline/stop with nothing to salvage, an unreadable transcript*, or an
// exception), both routes persisted `finalTranscript ?? openingTranscript` —
// i.e. only the user's own message. The assistant's error text was sent to
// the client but never saved, so a reload showed the user's question with no
// reply, and the next turn's model saw an unanswered message. Production
// evidence: three consecutive user messages with no assistant reply in the
// largest conversation.
//
// (*an unreadable transcript is deliberately excluded from this fix — see
// the "A FAILED READ MUST NOT BECOME A WRITE" comment in the stream route;
// that path must keep saving nothing at all, which is not covered here.)
//
// This drives the REAL route handlers end to end (same pattern as
// tests/stream-disconnect.test.ts and tests/agent-json-running.test.ts)
// rather than re-implementing their control flow, so a fix applied to the
// wrong branch cannot pass by accident.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { turnFailureMessage } from '@/lib/agent/failure-copy';

const ACC = 'acct-1';

// ---------------------------------------------------------------------------
// Shared mocks for both routes.
// ---------------------------------------------------------------------------

vi.mock('@/lib/db', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) } }));

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

vi.mock('@/lib/documents/attachments', () => ({ bindAttachments: vi.fn(async () => {}) }));
vi.mock('@/lib/documents/attachment-bindings', () => ({ bindAttachmentToMessage: vi.fn(async () => {}) }));
vi.mock('@/lib/agent/personas', () => ({ parseMentions: vi.fn(() => []) }));
vi.mock('@/lib/agent/context', () => ({ loadAgentContext: vi.fn(async () => ({})) }));

// No candidate has ever failed in these tests, so providersLookDown() must
// read as false — the incomplete-turn message is then the plain, predictable
// variant computed below via the real turnFailureMessage.
vi.mock('@/lib/ai/health', () => ({ healthSnapshot: () => [] }));

// Best-effort ticket filing (stream route only) — never the point of this
// file, and must never be allowed to interfere with saveConversation.
vi.mock('@/lib/support/tickets', () => ({ fileFailure: vi.fn(async () => ({ ticketId: 't1', created: true, regressed: false })) }));

const saveConversation = vi.fn(async (args: any) => args.id || 'conv-new');
const loadTranscriptResult = vi.fn(async (_id?: any, _acc?: any) => ({ messages: [] as any[], ok: true }));
const loadCarryover = vi.fn(async (_id?: any, _acc?: any) => null as any);
const ingestCarryoverFacts = vi.fn(async (_acc?: any, _memo?: any) => {});
const markConversationRunning = vi.fn(async (_id: string, _acc: string) => {});
const clearConversationRunning = vi.fn(async (_id: string, _acc: string) => {});
const clearStopRequest = vi.fn(async (_id: string, _acc: string) => {});
vi.mock('@/lib/agent/memory', () => ({
  saveConversation: (args: any) => saveConversation(args),
  loadTranscriptResult: (id: any, acc: any) => loadTranscriptResult(id, acc),
  loadCarryover: (id: any, acc: any) => loadCarryover(id, acc),
  ingestCarryoverFacts: (acc: any, memo: any) => ingestCarryoverFacts(acc, memo),
  markConversationRunning: (id: any, acc: any) => markConversationRunning(id, acc),
  clearConversationRunning: (id: any, acc: any) => clearConversationRunning(id, acc),
  clearStopRequest: (id: any, acc: any) => clearStopRequest(id, acc),
}));

// The JSON route reads ensureMessageIds' return value directly (not just
// calls it), so — unlike stream-disconnect.test.ts, which lets the stream
// route use the REAL transcript-store — this mock must behave like the real
// one closely enough to preserve array shape/order and mint stable ids,
// while staying simple and inspectable. mintMessageId is also stubbed so the
// JSON route's userMessageId is predictable.
vi.mock('@/lib/agent/transcript-store', () => ({
  mintMessageId: () => 'msg-user-1',
  ensureMessageIds: (msgs: any[]) => (msgs || []).map((m, i) => (m?.id ? m : { ...m, id: `stub-${i}` })),
}));

let runAgentStreamBehavior: (args: any, emit: (e: any) => void) => Promise<void> = async () => {};
const runAgentStream = vi.fn((args: any, emit: any) => runAgentStreamBehavior(args, emit));
let runAgentBehavior: (args: any) => Promise<any> = async () => ({ status: 'done', message: 'ok', transcript: [], steps: [] });
const runAgent = vi.fn((args: any) => runAgentBehavior(args));
vi.mock('@/lib/agent/loop', () => ({
  runAgentStream: (input: any, emit: any) => runAgentStream(input, emit),
  runAgent: (input: any) => runAgent(input),
  agentConfigured: () => true,
  generateCarryover: vi.fn(async () => null),
}));

beforeEach(() => {
  vi.clearAllMocks();
  runAgentStreamBehavior = async () => {};
  runAgentBehavior = async () => ({ status: 'done', message: 'ok', transcript: [], steps: [] });
});

function streamRequest(body: any) {
  return new NextRequest('http://localhost/api/agent/stream', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  });
}
function jsonRequest(body: any) {
  return new NextRequest('http://localhost/api/agent', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  });
}

async function drainStream(res: Response) {
  const reader = res.body!.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done } = await reader.read();
    if (done) return;
  }
}

function lastSavedTranscript(): any[] {
  expect(saveConversation).toHaveBeenCalled();
  return saveConversation.mock.calls.at(-1)![0].transcript;
}

// ---------------------------------------------------------------------------
// Stream route
// ---------------------------------------------------------------------------

describe('POST /api/agent/stream — error turns are persisted with the assistant reply (G8)', () => {
  it('an `error` event carrying its own transcript is saved as that transcript plus the error text', async () => {
    runAgentStreamBehavior = async (args, emit) => {
      emit({
        type: 'error',
        message: 'I gathered the details but had trouble summarizing. Please ask again a bit more specifically.',
        transcript: [...(args.transcript || []), { role: 'user', content: args.message }],
      });
    };
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(streamRequest({ message: 'summarize this' }));
    await drainStream(res);

    const t = lastSavedTranscript();
    expect(t.length).toBeGreaterThan(0);
    const last = t[t.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('I gathered the details but had trouble summarizing. Please ask again a bit more specifically.');
    // Never a turn whose last entry is the user message when an error was sent.
    expect(t.some((m: any) => m.role === 'user' && m.content === 'summarize this')).toBe(true);
  });

  it('an `error` event with NO transcript field falls back to openingTranscript (user message) plus the error text', async () => {
    runAgentStreamBehavior = async (_args, emit) => {
      emit({ type: 'error', message: 'That action can no longer be approved.' });
    };
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(streamRequest({ message: 'do the risky thing' }));
    await drainStream(res);

    const t = lastSavedTranscript();
    expect(t.some((m: any) => m.role === 'user' && m.content === 'do the risky thing')).toBe(true);
    const last = t[t.length - 1];
    expect(last).toEqual(expect.objectContaining({ role: 'assistant', content: 'That action can no longer be approved.' }));
  });

  it('the `!terminalSent` fallback (loop resolves with no terminal event) is persisted the same way', async () => {
    runAgentStreamBehavior = async (_args, emit) => {
      emit({ type: 'step_start', text: 'Thinking…' });
      // ...and stops. No final/needs_approval/error.
    };
    const expectedMessage = turnFailureMessage({ reason: 'incomplete', providersDown: false, hadAttachment: false });
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(streamRequest({ message: 'hello there' }));
    await drainStream(res);

    const t = lastSavedTranscript();
    const last = t[t.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe(expectedMessage);
    expect(t.some((m: any) => m.role === 'user' && m.content === 'hello there')).toBe(true);
  });

  it('an approve-resume (no new user message) that errors persists the base transcript plus the error text', async () => {
    // Existing conversation already has history; this turn is a pure
    // approve-resume (no `message`), so there is no openingTranscript of its
    // own — the base must fall back to the transcript loaded from the DB.
    loadTranscriptResult.mockResolvedValueOnce({
      messages: [{ role: 'user', content: 'earlier question', id: 'm1' }, { role: 'assistant', content: 'earlier answer', id: 'm2' }],
      ok: true,
    });
    runAgentStreamBehavior = async (_args, emit) => {
      emit({ type: 'error', message: "I couldn't record that action for your approval, so I haven't run it. Please try again." });
    };
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(streamRequest({
      conversationId: 'conv-existing',
      approve: { approvalId: 'appr-1', tool: 'someSensitiveTool', args: {} },
    }));
    await drainStream(res);

    const t = lastSavedTranscript();
    expect(t[0]).toEqual(expect.objectContaining({ content: 'earlier question' }));
    expect(t[1]).toEqual(expect.objectContaining({ content: 'earlier answer' }));
    const last = t[t.length - 1];
    expect(last).toEqual(expect.objectContaining({
      role: 'assistant',
      content: "I couldn't record that action for your approval, so I haven't run it. Please try again.",
    }));
  });

  it('a normal `final` path is unchanged: last saved entry is the final answer, nothing appended after it', async () => {
    runAgentStreamBehavior = async (args, emit) => {
      emit({
        type: 'final',
        transcript: [...(args.transcript || []), { role: 'user', content: args.message }, { role: 'assistant', content: 'the real answer' }],
      });
    };
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(streamRequest({ message: 'hello there' }));
    await drainStream(res);

    const t = lastSavedTranscript();
    expect(t.length).toBe(2);
    expect(t[t.length - 1]).toEqual(expect.objectContaining({ role: 'assistant', content: 'the real answer' }));
  });
});

// ---------------------------------------------------------------------------
// JSON route
// ---------------------------------------------------------------------------

describe('POST /api/agent (JSON) — error turns are persisted with the assistant reply (G8)', () => {
  it("status:'error' persists the assistant error message exactly once", async () => {
    runAgentBehavior = async (args: any) => ({
      status: 'error',
      message: "I couldn't complete that request. Please rephrase and try again.",
      transcript: [...(args.transcript || []), { role: 'user', content: args.message }],
      steps: [],
    });
    const { POST } = await import('@/app/api/agent/route');
    const res = await POST(jsonRequest({ message: 'do something impossible' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('error');

    const t = lastSavedTranscript();
    const assistantEntries = t.filter((m: any) => m.role === 'assistant' && m.content === "I couldn't complete that request. Please rephrase and try again.");
    expect(assistantEntries.length).toBe(1);
    expect(t[t.length - 1]).toEqual(expect.objectContaining({
      role: 'assistant', content: "I couldn't complete that request. Please rephrase and try again.",
    }));
    expect(t.some((m: any) => m.role === 'user' && m.content === 'do something impossible')).toBe(true);
  });

  it('does not double-append when result.transcript already ends with the assistant error message', async () => {
    runAgentBehavior = async (args: any) => ({
      status: 'error',
      message: 'already appended',
      transcript: [...(args.transcript || []), { role: 'user', content: args.message }, { role: 'assistant', content: 'already appended' }],
      steps: [],
    });
    const { POST } = await import('@/app/api/agent/route');
    await POST(jsonRequest({ message: 'hi' }));

    const t = lastSavedTranscript();
    const assistantEntries = t.filter((m: any) => m.role === 'assistant' && m.content === 'already appended');
    expect(assistantEntries.length).toBe(1);
  });

  it('a normal done turn is unchanged: no extra assistant message appended', async () => {
    runAgentBehavior = async (args: any) => ({
      status: 'done',
      message: 'the real answer',
      transcript: [...(args.transcript || []), { role: 'user', content: args.message }, { role: 'assistant', content: 'the real answer' }],
      steps: [],
    });
    const { POST } = await import('@/app/api/agent/route');
    await POST(jsonRequest({ message: 'hi' }));

    const t = lastSavedTranscript();
    expect(t.length).toBe(2);
    expect(t[t.length - 1]).toEqual(expect.objectContaining({ role: 'assistant', content: 'the real answer' }));
  });

  it('the wire response transcript is unchanged by the G8 fix (rule 4: never change what goes to the client)', async () => {
    runAgentBehavior = async (args: any) => ({
      status: 'error',
      message: 'oops',
      transcript: [...(args.transcript || []), { role: 'user', content: args.message }],
      steps: [],
    });
    const { POST } = await import('@/app/api/agent/route');
    const res = await POST(jsonRequest({ message: 'hi' }));
    const body = await res.json();

    // The wire's own transcript field must NOT carry the appended assistant
    // error entry — only the persisted copy (asserted above) does.
    expect(body.transcript.some((m: any) => m.role === 'assistant' && m.content === 'oops')).toBe(false);
    expect(body.message).toBe('oops');
  });
});

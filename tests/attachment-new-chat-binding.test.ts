// Defect 1: a file dropped into a BRAND-NEW chat used to be orphaned forever.
//
// app/api/agent/stream/route.ts only bound attachmentIds when a conversationId
// was already present on the request. For a new chat there is no id yet — it
// is minted forty-odd lines later by the opening saveConversation — so the
// bind was skipped, not retried, and the row kept conversation_id NULL.
// listAttachments filters `conversation_id.eq.X OR scope.eq.library`, and NULL
// matches neither: the file becomes permanently invisible to every later turn
// while still occupying storage. Confirmed against production data: 2 of 5
// attachment rows orphaned this exact way.
//
// This drives the REAL route handler end to end (same pattern as
// tests/stream-disconnect.test.ts) rather than re-implementing the binding
// logic, so it can only pass if the route itself calls bindAttachments against
// the id the turn actually created.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const ACC = 'acct-1';
const NEW_ID = 'conv-new';
const ATTACHMENT_ID = '11111111-1111-1111-1111-111111111111';

vi.mock('@/lib/db', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) } }));

const logError = vi.fn();
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: (...a: any[]) => logError(...a), request: vi.fn() },
  requestStore: { run: (_store: any, fn: any) => fn() },
  enrichContext: vi.fn(),
  currentContext: () => undefined,
}));

vi.mock('@/lib/session', () => ({
  verifySession: vi.fn(async () => ({ email: 'op@example.com', accountId: ACC, role: 'owner', exp: 0 })),
  SESSION_COOKIE: 'ma_session',
}));

const bindAttachments = vi.fn(async (_acc: string, _ids: string[], _convId: string) => 1);
vi.mock('@/lib/documents/attachments', () => ({ bindAttachments: (acc: any, ids: any, convId: any) => bindAttachments(acc, ids, convId) }));
vi.mock('@/lib/agent/personas', () => ({ parseMentions: vi.fn(() => []) }));
vi.mock('@/lib/agent/context', () => ({ loadAgentContext: vi.fn(async () => ({})) }));

const saveConversation = vi.fn(async (args: any) => args.id || NEW_ID);
const loadTranscriptResult = vi.fn(async (_id?: any, _acc?: any) => ({ messages: [] as any[], ok: true }));
const loadCarryover = vi.fn(async (_id?: any, _acc?: any) => null as any);
const ingestCarryoverFacts = vi.fn(async (_acc?: any, _memo?: any) => {});
const markConversationRunning = vi.fn(async (_id: string, _acc: string) => {});
const clearConversationRunning = vi.fn(async (_id: string, _acc: string) => {});
vi.mock('@/lib/agent/memory', () => ({
  saveConversation: (args: any) => saveConversation(args),
  loadTranscriptResult: (id: any, acc: any) => loadTranscriptResult(id, acc),
  loadCarryover: (id: any, acc: any) => loadCarryover(id, acc),
  ingestCarryoverFacts: (acc: any, memo: any) => ingestCarryoverFacts(acc, memo),
  markConversationRunning: (id: any, acc: any) => markConversationRunning(id, acc),
  clearConversationRunning: (id: any, acc: any) => clearConversationRunning(id, acc),
}));

const runAgentStream = vi.fn(async (args: any, emit: (e: any) => void) => {
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

beforeEach(() => { vi.clearAllMocks(); });

function makeRequest(body: any) {
  return new NextRequest('http://localhost/api/agent/stream', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function drain(res: Response) {
  const reader = res.body!.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done } = await reader.read();
    if (done) return;
  }
}

describe('POST /api/agent/stream — attachments dropped into a brand-new chat', () => {
  it('binds the attachment to the id THIS turn minted, not the (absent) incoming id', async () => {
    const { POST } = await import('@/app/api/agent/stream/route');
    // No conversationId in the body at all — this is the new-chat case.
    const res = await POST(makeRequest({ message: 'take a look at the doc attached', attachmentIds: [ATTACHMENT_ID] }));
    await drain(res);

    expect(bindAttachments).toHaveBeenCalledTimes(1);
    expect(bindAttachments).toHaveBeenCalledWith(ACC, [ATTACHMENT_ID], NEW_ID);
    // Never called with undefined — that is precisely the skipped-and-never-
    // retried call the old code made (a no-op, since bindAttachments itself
    // guards on `!conversationId`, but only by accident of that guard, not by
    // this route ever getting the id right).
    expect(bindAttachments).not.toHaveBeenCalledWith(ACC, [ATTACHMENT_ID], undefined);
  });

  it('does NOT bind twice when the request already carries a conversationId', async () => {
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest({ message: 'hi', conversationId: 'conv-existing', attachmentIds: [ATTACHMENT_ID] }));
    await drain(res);

    expect(bindAttachments).toHaveBeenCalledTimes(1);
    expect(bindAttachments).toHaveBeenCalledWith(ACC, [ATTACHMENT_ID], 'conv-existing');
  });

  it('logs a bind failure instead of silently discarding it, and still finishes the turn', async () => {
    bindAttachments.mockRejectedValueOnce(new Error('boom'));
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest({ message: 'hi', attachmentIds: [ATTACHMENT_ID] }));
    const chunks: string[] = [];
    const reader = res.body!.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(new TextDecoder().decode(value));
    }
    const all = chunks.join('');

    // The turn still ran and produced its answer — a bind failure must not
    // fail the turn.
    expect(all).toContain('the assistant answer');
    expect(all).toContain('data: [DONE]');

    // But the failure itself was not thrown away: some log.error call names
    // the bind failure specifically, rather than every event just vanishing
    // into a `.catch(() => 0)`.
    const bindFailureLogs = logError.mock.calls.filter((c) => String(c[0]).toLowerCase().includes('bindattachments'));
    expect(bindFailureLogs.length).toBeGreaterThan(0);
  });
});

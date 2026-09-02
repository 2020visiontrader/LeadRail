// FIX 2 (see the task spec this shipped under): app/api/agent/route.ts (the
// JSON path — most of production traffic) never called
// markConversationRunning/clearConversationRunning, so a reload mid-turn on
// that path showed the saved transcript with no spinner and no polling: GET
// /api/agent/conversations/[id] reported running: false the whole time a
// turn was actually running.
//
// This drives the REAL route handler (same pattern as
// tests/conversation-running-stream.test.ts) so it can only pass if the
// route itself calls through, not a reimplementation of the bookkeeping.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const ACC = 'acct-1';

vi.mock('@/lib/db', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) } }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
  requestStore: { run: (_store: any, fn: any) => fn() },
  enrichContext: vi.fn(),
  currentContext: () => undefined as any,
}));
vi.mock('@/lib/session', () => ({
  verifySession: vi.fn(async () => ({ email: 'op@example.com', accountId: ACC, role: 'owner', exp: 0 })),
  SESSION_COOKIE: 'ma_session',
}));
vi.mock('@/lib/documents/attachments', () => ({ bindAttachments: vi.fn(async () => 0) }));
vi.mock('@/lib/documents/attachment-bindings', () => ({ bindAttachmentToMessage: vi.fn(async () => {}) }));
vi.mock('@/lib/agent/personas', () => ({ parseMentions: vi.fn(() => []) }));
vi.mock('@/lib/agent/context', () => ({ loadAgentContext: vi.fn(async () => ({})) }));
vi.mock('@/lib/agent/transcript-store', () => ({
  mintMessageId: () => 'msg-1',
  // ensureMessageIds is exercised for real behaviour in
  // tests/transcript-store.test.ts; this route test only needs the route to
  // be able to call it without throwing, so a same-shape passthrough stub is
  // enough here.
  ensureMessageIds: (msgs: any[]) => (msgs || []).map((m) => (m?.id ? m : { ...m, id: 'stub-id' })),
}));

const saveConversation = vi.fn(async (args: any) => args.id || 'conv-new');
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

let runBehavior: 'succeed' | 'throw' = 'succeed';
const runAgent = vi.fn(async (args: any) => {
  if (runBehavior === 'throw') throw new Error('agent blew up');
  return {
    status: 'done',
    message: 'the assistant answer',
    transcript: [
      ...(args.transcript || []),
      { role: 'user', content: args.message },
      { role: 'assistant', content: 'the assistant answer' },
    ],
    steps: [],
  };
});
vi.mock('@/lib/agent/loop', () => ({
  runAgent: (input: any) => runAgent(input),
  agentConfigured: () => true,
  generateCarryover: vi.fn(async () => null),
}));

beforeEach(() => { vi.clearAllMocks(); runBehavior = 'succeed'; });

function makeRequest(body: any) {
  return new NextRequest('http://localhost/api/agent', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/agent (JSON) — in-flight run bookkeeping (migration 072)', () => {
  it('marks and clears an EXISTING conversation using the id the request already carried', async () => {
    const { POST } = await import('@/app/api/agent/route');
    const res = await POST(makeRequest({ message: 'hello there', conversationId: 'conv-existing' }));
    expect(res.status).toBe(200);

    expect(markConversationRunning).toHaveBeenCalledWith('conv-existing', ACC);
    expect(clearConversationRunning).toHaveBeenCalledWith('conv-existing', ACC);
    // Marked BEFORE it was cleared, not the other way round.
    const markOrder = markConversationRunning.mock.invocationCallOrder[0];
    const clearOrder = clearConversationRunning.mock.invocationCallOrder[0];
    expect(markOrder).toBeLessThan(clearOrder);
  });

  it('still clears the flag when the agent run throws — the finally block is the one guarantee this rides on', async () => {
    runBehavior = 'throw';
    const { POST } = await import('@/app/api/agent/route');
    // withApi (lib/http.ts) catches the throw and converts it to a 500
    // response rather than rejecting — the flag bookkeeping still has to run
    // on the way out, via the route's own try/finally, before that happens.
    const res = await POST(makeRequest({ message: 'hello there', conversationId: 'conv-existing' }));
    expect(res.status).toBe(500);

    expect(markConversationRunning).toHaveBeenCalledWith('conv-existing', ACC);
    expect(clearConversationRunning).toHaveBeenCalledWith('conv-existing', ACC);
  });

  it('does not touch the running flag for a brand-new chat with no conversationId yet', async () => {
    const { POST } = await import('@/app/api/agent/route');
    const res = await POST(makeRequest({ message: 'hello there' }));
    expect(res.status).toBe(200);

    expect(markConversationRunning).not.toHaveBeenCalled();
    expect(clearConversationRunning).not.toHaveBeenCalled();
  });
});

// Defect 2, the write side: the stream route must mark a conversation running
// before the (potentially long) agent run starts, and clear it in `finally` —
// unconditionally, whether the turn succeeded, errored, or the client left.
// Drives the real route handler (same pattern as tests/stream-disconnect.test.ts)
// so this can only pass if the route itself calls through, not a
// re-implementation of the bookkeeping.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const ACC = 'acct-1';

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
vi.mock('@/lib/documents/attachments', () => ({ bindAttachments: vi.fn(async () => 0) }));
vi.mock('@/lib/agent/personas', () => ({ parseMentions: vi.fn(() => []) }));
vi.mock('@/lib/agent/context', () => ({ loadAgentContext: vi.fn(async () => ({})) }));

const saveConversation = vi.fn(async (args: any) => args.id || 'conv-new');
const loadTranscriptResult = vi.fn(async (_id?: any, _acc?: any) => ({ messages: [] as any[], ok: true }));
const loadCarryover = vi.fn(async (_id?: any, _acc?: any) => null as any);
const ingestCarryoverFacts = vi.fn(async (_acc?: any, _memo?: any) => {});
const markConversationRunning = vi.fn(async (_id: string, _acc: string) => {});
const clearConversationRunning = vi.fn(async (_id: string, _acc: string) => {});
// Cooperative stop (migration 083, DEFECT B fix) — the stream route now
// clears a stop request in its `finally` block, at turn END, alongside
// clearConversationRunning (no longer at turn start — see the route's own
// comment) — so this mock needs a stand-in or that call throws.
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

let runBehavior: 'succeed' | 'throw' = 'succeed';
const runAgentStream = vi.fn(async (args: any, emit: (e: any) => void) => {
  if (runBehavior === 'throw') throw new Error('agent blew up');
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

beforeEach(() => { vi.clearAllMocks(); runBehavior = 'succeed'; });

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

describe('POST /api/agent/stream — in-flight run bookkeeping (migration 072)', () => {
  it('marks a NEW conversation running (against the id it just minted) and clears it once the turn completes', async () => {
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest({ message: 'hello there' }));
    await drain(res);

    expect(markConversationRunning).toHaveBeenCalledWith('conv-new', ACC);
    expect(clearConversationRunning).toHaveBeenCalledWith('conv-new', ACC);
    // Marked BEFORE it was cleared, not the other way round.
    const markOrder = markConversationRunning.mock.invocationCallOrder[0];
    const clearOrder = clearConversationRunning.mock.invocationCallOrder[0];
    expect(markOrder).toBeLessThan(clearOrder);
  });

  it('marks and clears an EXISTING conversation using the id the request already carried', async () => {
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest({ message: 'hello there', conversationId: 'conv-existing' }));
    await drain(res);

    expect(markConversationRunning).toHaveBeenCalledWith('conv-existing', ACC);
    expect(clearConversationRunning).toHaveBeenCalledWith('conv-existing', ACC);
  });

  it('still clears the flag when the agent run throws — the finally block is the one guarantee this rides on', async () => {
    runBehavior = 'throw';
    const { POST } = await import('@/app/api/agent/stream/route');
    const res = await POST(makeRequest({ message: 'hello there', conversationId: 'conv-existing' }));
    await drain(res);

    expect(markConversationRunning).toHaveBeenCalledWith('conv-existing', ACC);
    expect(clearConversationRunning).toHaveBeenCalledWith('conv-existing', ACC);
  });
});

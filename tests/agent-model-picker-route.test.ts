// Composer model picker (Part 1) — the security-relevant piece: a client-
// supplied modelId is validated against THIS account's own enabled ai_models
// rows (assertSelectableModel, lib/ai/providers.ts) before it can reach
// runAgent/runAgentStream. A modelId that does NOT belong to the account is
// IGNORED, never trusted straight through.
//
// Drives the REAL route handlers (same pattern as
// tests/agent-json-running.test.ts / tests/attachment-new-chat-binding.test.ts),
// not a reimplementation, so this can only pass if the routes themselves call
// through to assertSelectableModel and thread the result into modelId.

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
  clearStopRequest: async () => {},
}));

// The one thing under test: does the route consult this before trusting the
// client's modelId? Controllable per-test so both the "belongs to this
// account" and "does not" paths are exercised without a real DB.
const assertSelectableModel = vi.fn(async (_acc: string, modelId: string | undefined) =>
  modelId === 'owned-model-row' ? modelId : undefined,
);
vi.mock('@/lib/ai/providers', () => ({
  assertSelectableModel: (acc: string, modelId: string | undefined) => assertSelectableModel(acc, modelId),
}));

const runAgent = vi.fn(async (args: any) => ({
  status: 'done',
  message: 'the assistant answer',
  transcript: [...(args.transcript || []), { role: 'user', content: args.message }, { role: 'assistant', content: 'the assistant answer' }],
  steps: [],
}));
vi.mock('@/lib/agent/loop', () => ({
  runAgent: (input: any) => runAgent(input),
  runAgentStream: vi.fn(async (args: any, emit: any) => {
    emit({
      type: 'final',
      transcript: [...(args.transcript || []), { role: 'user', content: args.message }, { role: 'assistant', content: 'the assistant answer' }],
    });
  }),
  agentConfigured: () => true,
  generateCarryover: vi.fn(async () => null),
}));

beforeEach(() => { vi.clearAllMocks(); });

function makeJsonRequest(body: any) {
  return new NextRequest('http://localhost/api/agent', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  });
}
function makeStreamRequest(body: any) {
  return new NextRequest('http://localhost/api/agent/stream', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  });
}
async function drain(res: Response) {
  const reader = res.body!.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) { const { done } = await reader.read(); if (done) return; }
}

describe('POST /api/agent (JSON) — composer model picker', () => {
  it('a modelId that belongs to this account reaches runAgent', async () => {
    const { POST } = await import('@/app/api/agent/route');
    const res = await POST(makeJsonRequest({ message: 'hi', conversationId: 'conv-existing', modelId: 'owned-model-row' }));
    expect(res.status).toBe(200);

    expect(assertSelectableModel).toHaveBeenCalledWith(ACC, 'owned-model-row');
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0][0].modelId).toBe('owned-model-row');
  });

  it('SECURITY: a modelId that does not belong to this account is IGNORED, not passed through', async () => {
    const { POST } = await import('@/app/api/agent/route');
    const res = await POST(makeJsonRequest({ message: 'hi', conversationId: 'conv-existing', modelId: 'someone-elses-model-row' }));
    expect(res.status).toBe(200);

    expect(assertSelectableModel).toHaveBeenCalledWith(ACC, 'someone-elses-model-row');
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0][0].modelId).toBeUndefined();
  });

  it('Auto: no modelId in the body means no validation call and nothing sent — unchanged behaviour', async () => {
    const { POST } = await import('@/app/api/agent/route');
    const res = await POST(makeJsonRequest({ message: 'hi', conversationId: 'conv-existing' }));
    expect(res.status).toBe(200);

    expect(assertSelectableModel).toHaveBeenCalledWith(ACC, undefined);
    expect(runAgent.mock.calls[0][0].modelId).toBeUndefined();
  });
});

describe('POST /api/agent/stream — composer model picker', () => {
  it('a modelId that belongs to this account reaches runAgentStream', async () => {
    const { POST } = await import('@/app/api/agent/stream/route');
    const { runAgentStream } = await import('@/lib/agent/loop');
    const res = await POST(makeStreamRequest({ message: 'hi', conversationId: 'conv-existing', modelId: 'owned-model-row' }));
    await drain(res);

    expect(assertSelectableModel).toHaveBeenCalledWith(ACC, 'owned-model-row');
    expect((runAgentStream as any).mock.calls[0][0].modelId).toBe('owned-model-row');
  });

  it('SECURITY: a modelId that does not belong to this account is IGNORED, not passed through', async () => {
    const { POST } = await import('@/app/api/agent/stream/route');
    const { runAgentStream } = await import('@/lib/agent/loop');
    const res = await POST(makeStreamRequest({ message: 'hi', conversationId: 'conv-existing', modelId: 'someone-elses-model-row' }));
    await drain(res);

    expect(assertSelectableModel).toHaveBeenCalledWith(ACC, 'someone-elses-model-row');
    expect((runAgentStream as any).mock.calls[0][0].modelId).toBeUndefined();
  });
});

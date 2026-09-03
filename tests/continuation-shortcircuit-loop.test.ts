// Pending-approval continuation short-circuit (lib/agent/continuation-shortcircuit.ts).
//
// When an approval is pending for a conversation, a user typing "continue"
// used to run the WHOLE loop — full system prompt, full transcript, a model
// call — just to produce "still waiting on your approval". This drives the
// REAL runAgent / runAgentStream loops (same harness as
// tests/agent-stop-loop.test.ts), not a reimplementation, so it can only pass
// if the actual loop.ts short-circuit branch runs.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const runToolMock = vi.fn();
const pendingApprovalForConversationMock = vi.fn();

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/credits', () => ({
  markParseOutcome: vi.fn(),
  recordAiUsage: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: {
    draftOutreach: { title: 'Draft outreach email', sensitive: false },
    listTags: { title: 'List Tags', sensitive: false },
  },
  runTool: (...a: any[]) => runToolMock(...a),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  capabilityFor: () => undefined,
  toolsFromCapabilities: () => ({}),
}));
vi.mock('@/lib/capabilities/external-mcp', () => ({ loadExternalCapabilities: async () => [] }));
vi.mock('@/lib/agent/personas', () => ({
  loadPersonaForAgent: async () => null,
  resolveMentionedPersonas: async () => [],
  getCoordinator: async () => null,
  selectPersonasForRequest: async () => [],
  buildPersonaSystemBlock: () => '',
  buildCoordinatorSystemBlock: () => '',
  parseMentions: () => [],
}));
vi.mock('@/lib/skills/store', () => ({ loadEnabledSkillsForAgent: async () => [] }));
vi.mock('@/lib/agent/compose', () => ({ composeAnswer: async (a: any) => a?.draft ?? '' }));
vi.mock('@/lib/approvals/store', () => ({
  createApproval: async () => null,
  consumeApprovalForExecution: vi.fn(),
  markApprovedByToolAndArgs: vi.fn(),
  recordExecutedApproval: vi.fn(),
  ApprovalExecutionError: class extends Error {},
  pendingApprovalForConversation: (...a: any[]) => pendingApprovalForConversationMock(...a),
}));
vi.mock('@/lib/approvals/grants', () => ({ consumeGrant: async () => null, isGrantable: () => false }));
vi.mock('@/lib/capabilities/delegation', () => ({
  beginDelegationScope: vi.fn(), endDelegationScope: vi.fn(), setDelegationContext: vi.fn(),
}));
vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: async () => ({ skillIds: [] }) }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));
// isStopRequested faked out to always say "not stopped" — irrelevant to this
// suite, but the real memory module is otherwise used (estimateTokens etc).
vi.mock('@/lib/agent/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/memory')>();
  return { ...actual, isStopRequested: async () => false };
});

const PENDING_SINGLE = {
  id: 'appr-1',
  account_id: 'acct-1',
  conversation_id: 'conv-1',
  tool: 'sendEmail',
  title: 'Send outreach email',
  summary: 'Send "Quick note" to Markus at markus@example.com.',
  args_redacted: { to: 'markus@example.com', subject: 'Quick note' },
  args_hash: 'hash1',
  state: 'pending',
  requested_by: null,
  decided_by: null,
  decided_at: null,
  comment: null,
  expires_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  has_encrypted_args: false,
};

const PENDING_BATCH = {
  ...PENDING_SINGLE,
  id: 'appr-2',
  tool: 'enrichLead',
  title: 'Enrich leads',
  summary: 'Enrich 12 leads with firmographic data.',
  args_redacted: { calls: Array.from({ length: 12 }, (_, i) => ({ leadId: `lead-${i}` })) },
};

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runToolMock.mockReset();
  pendingApprovalForConversationMock.mockReset();
});

describe('runAgent (JSON, non-streaming) — pending-approval continuation short-circuit', () => {
  it('"continue" with an approval pending short-circuits: NO model call, names the tool, and persists the exchange', async () => {
    pendingApprovalForConversationMock.mockResolvedValue(PENDING_SINGLE);

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'continue', conversationId: 'conv-1' });

    expect(res.status).toBe('done');
    expect(res.message).toContain('Send outreach email');
    expect(res.message).toMatch(/waiting on your approval/i);
    expect(res.message).toContain('Send "Quick note" to Markus at markus@example.com.');
    expect(generateChat).not.toHaveBeenCalled();
    expect(pendingApprovalForConversationMock).toHaveBeenCalledWith('acct-1', 'conv-1');

    // Persisted like an ordinary exchange: user turn + assistant reply both
    // land in the transcript that the caller (saveConversation) persists.
    expect(res.transcript.at(-2)).toMatchObject({ role: 'user', content: 'continue' });
    expect(res.transcript.at(-1)).toMatchObject({ role: 'assistant', content: res.message });
  });

  it('reports the batch item count when the pending approval is a batch', async () => {
    pendingApprovalForConversationMock.mockResolvedValue(PENDING_BATCH);

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'any update', conversationId: 'conv-1' });

    expect(res.status).toBe('done');
    expect(res.message).toContain('Enrich leads');
    expect(res.message).toContain('12');
    expect(generateChat).not.toHaveBeenCalled();
  });

  it('"continue with the other leads" does NOT short-circuit — it is a real instruction and reaches the model', async () => {
    pendingApprovalForConversationMock.mockResolvedValue(PENDING_SINGLE);
    generateChat.mockResolvedValueOnce(JSON.stringify({ action: 'final', message: 'On it.' }));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'continue with the other leads', conversationId: 'conv-1' });

    expect(generateChat).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('done');
    expect(res.message).toBe('On it.');
  });

  it('"continue" with NO approval pending does NOT short-circuit', async () => {
    pendingApprovalForConversationMock.mockResolvedValue(null);
    generateChat.mockResolvedValueOnce(JSON.stringify({ action: 'final', message: 'Continuing now.' }));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'continue', conversationId: 'conv-1' });

    expect(pendingApprovalForConversationMock).toHaveBeenCalled();
    expect(generateChat).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('done');
    expect(res.message).toBe('Continuing now.');
  });

  it('a failing approvals lookup falls through to the normal path (never swallows the turn)', async () => {
    pendingApprovalForConversationMock.mockRejectedValue(new Error('db hiccup'));
    generateChat.mockResolvedValueOnce(JSON.stringify({ action: 'final', message: 'Still working on it.' }));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'continue', conversationId: 'conv-1' });

    expect(generateChat).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('done');
    expect(res.message).toBe('Still working on it.');
  });

  it('a message with no conversationId never short-circuits (nothing to scope the lookup to)', async () => {
    generateChat.mockResolvedValueOnce(JSON.stringify({ action: 'final', message: 'done' }));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'continue' });

    expect(pendingApprovalForConversationMock).not.toHaveBeenCalled();
    expect(generateChat).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('done');
  });
});

describe('runAgentStream (streaming) — must match runAgentImpl', () => {
  it('"continue" with an approval pending short-circuits with a normal final event and NO model call', async () => {
    pendingApprovalForConversationMock.mockResolvedValue(PENDING_SINGLE);

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'continue', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    expect(generateChat).not.toHaveBeenCalled();
    const finalEvents = events.filter((e) => e.type === 'final');
    expect(finalEvents.length).toBe(1);
    expect(finalEvents[0].message).toContain('Send outreach email');
    expect(finalEvents[0].message).toMatch(/waiting on your approval/i);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    // Rendered exactly like a normal assistant message: final_delta tokens
    // preceded the terminal final event.
    expect(events.some((e) => e.type === 'final_delta')).toBe(true);
    const finalDeltaIndex = events.findIndex((e) => e.type === 'final_delta');
    const finalIndex = events.findIndex((e) => e.type === 'final');
    expect(finalDeltaIndex).toBeGreaterThanOrEqual(0);
    expect(finalDeltaIndex).toBeLessThan(finalIndex);

    const transcriptText = JSON.stringify(finalEvents[0].transcript);
    expect(transcriptText).toContain('continue');
    expect(transcriptText).toContain('Send outreach email');
  });

  it('"continue with the other leads" does NOT short-circuit in the streaming loop either', async () => {
    pendingApprovalForConversationMock.mockResolvedValue(PENDING_SINGLE);
    generateChat.mockResolvedValueOnce(JSON.stringify({ action: 'final', message: 'On it.' }));

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'continue with the other leads', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    expect(generateChat).toHaveBeenCalledTimes(1);
    const finalEvents = events.filter((e) => e.type === 'final');
    expect(finalEvents[0].message).toBe('On it.');
  });

  it('a failing approvals lookup falls through to the normal path in the streaming loop', async () => {
    pendingApprovalForConversationMock.mockRejectedValue(new Error('db hiccup'));
    generateChat.mockResolvedValueOnce(JSON.stringify({ action: 'final', message: 'Still working on it.' }));

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'continue', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    expect(generateChat).toHaveBeenCalledTimes(1);
    const finalEvents = events.filter((e) => e.type === 'final');
    expect(finalEvents[0].message).toBe('Still working on it.');
  });
});

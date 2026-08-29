// PRODUCTION INCIDENT 2026-08-28: the forced-final call (the one that answers
// after the step loop breaks out, or gives up on tool-routing) used to route
// completely differently from the step loop's own model calls: `accountId`
// was passed ONLY when a persona model override was active, there was no
// `task` tag, and the call hard-pinned `model: AGENT_OPENCODE_MODEL` — the
// tier that was returning 401 in production. Tools succeeded, reasoning
// succeeded, and then the LAST call of the turn died on a dead tier that the
// step loop never touched, because the step loop passed `accountId`
// unconditionally and tagged its calls `task: 'reason'`.
//
// These drive the REAL runAgent / runAgentStream loops (not a
// reimplementation) — same harness as tests/agent-salvage.test.ts — and
// assert on the actual arguments handed to generateChat for the forced-final
// call, which is the only way to prove the routing fix is actually wired in
// (as opposed to merely present somewhere in the file).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const runToolMock = vi.fn();
const warn = vi.fn();

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
  log: { info: vi.fn(), warn: (...a: any[]) => warn(...a), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: {
    listTags: { title: 'List Tags', sensitive: false },
    listLeads: { title: 'List Leads', sensitive: false },
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
  ApprovalExecutionError: class extends Error {},
}));
vi.mock('@/lib/approvals/grants', () => ({ consumeGrant: async () => null, isGrantable: () => false }));
vi.mock('@/lib/capabilities/delegation', () => ({
  beginDelegationScope: vi.fn(), endDelegationScope: vi.fn(), setDelegationContext: vi.fn(),
}));
vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: async () => ({ skillIds: [] }) }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));

const TOOL_CALL = (tool: string, args: Record<string, any>) => JSON.stringify({ action: 'tool', tool, args });
const DUP_TOOL_CALL = (tool: string, n: number) => TOOL_CALL(tool, { call: n });
const FINAL = JSON.stringify({ action: 'final', message: 'Here is your answer.' });

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runToolMock.mockReset();
  warn.mockReset();
});

/** Drives the loop into forced-final the same way tests/agent-salvage.test.ts
 *  does: repeat the same tool call until the duplicate-call guard breaks out
 *  of the ReAct loop, landing on the forced-final call — a real path through
 *  the real loop. */
function queueUpToForcedFinal(tool: string) {
  runToolMock.mockResolvedValue({ ok: true, result: { ok: true } });
  generateChat.mockResolvedValueOnce(DUP_TOOL_CALL(tool, 1));
  generateChat.mockResolvedValueOnce(DUP_TOOL_CALL(tool, 2));
  generateChat.mockResolvedValueOnce(DUP_TOOL_CALL(tool, 3)); // nudge 1
  generateChat.mockResolvedValueOnce(DUP_TOOL_CALL(tool, 4)); // nudge 2 -> forced final next
}

describe('runAgent (non-streaming) — forced-final call routing', () => {
  it('passes accountId on the forced-final call even with no persona model override', async () => {
    queueUpToForcedFinal('listTags');
    generateChat.mockResolvedValueOnce(FINAL);

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'what tags do we have?', conversationId: 'conv-1' });

    expect(res.status).toBe('done');
    const forcedFinalCall = generateChat.mock.calls[generateChat.mock.calls.length - 1][0];
    expect(forcedFinalCall.accountId).toBe('acct-1');
  });

  it('tags the forced-final call with a substantive task and does not hard-pin a model', async () => {
    queueUpToForcedFinal('listTags');
    generateChat.mockResolvedValueOnce(FINAL);

    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'what tags do we have?', conversationId: 'conv-1' });

    const forcedFinalCall = generateChat.mock.calls[generateChat.mock.calls.length - 1][0];
    expect(forcedFinalCall.task).toBe('draft');
    expect(forcedFinalCall.model).toBeUndefined();
    // The deliberate output-size bound stays — this is a summarization call,
    // not the step loop's open-ended reasoning.
    expect(forcedFinalCall.maxOutputTokens).toBe(2048);
  });
});

describe('runAgentStream (streaming) — forced-final call routing', () => {
  it('passes accountId and a substantive task on the forced-final call, no persona model set', async () => {
    queueUpToForcedFinal('listLeads');
    generateChat.mockResolvedValueOnce(FINAL);

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'which leads?', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    expect(events.some((e) => e.type === 'final')).toBe(true);
    const forcedFinalCall = generateChat.mock.calls[generateChat.mock.calls.length - 1][0];
    expect(forcedFinalCall.accountId).toBe('acct-1');
    expect(forcedFinalCall.task).toBe('draft');
    expect(forcedFinalCall.model).toBeUndefined();
  });
});

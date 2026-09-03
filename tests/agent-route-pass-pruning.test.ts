// The route-pass choke point: both runAgent (runAgentImpl) and runAgentStream
// (runAgentStreamImpl) must hand the router `pruneForWire(messages)`, not the
// full stored transcript, on every route-pass generateChat call — see
// lib/agent/transcript-store.ts's module comment and CLAUDE.md's "Two agent
// loops exist" rule (runAgentImpl and runAgentStreamImpl must stay
// identical).
//
// This drives the REAL loops (not a reimplementation): three tool-calling
// steps accumulate three OBSERVATION messages and two prior tool-call JSON
// envelopes in the stored transcript, then the LAST route-pass call's
// `messages` argument is inspected. If pruning is wired in:
//   - the two earlier assistant tool-call envelopes read "[called X]", not
//     the raw {"action":"tool",...} JSON.
//   - the oldest OBSERVATION (only 2 are kept in full) no longer carries its
//     raw JSON body, only its digest line.
// If the fix is reverted (pruneForWire === toWireMessages), all of that raw
// text is still present verbatim on the last call — this is the revertable
// half of the assertion, not just a smoke check.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const runToolMock = vi.fn();

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/credits', () => ({ markParseOutcome: vi.fn(), recordAiUsage: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: {
    listTags: { title: 'List Tags', sensitive: false },
    listLeads: { title: 'List Leads', sensitive: false },
    getPersona: { title: 'Get sender persona', sensitive: false },
  },
  runTool: (...a: any[]) => runToolMock(...a),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  // A real digest, so the oldest observation's reduction is provable: its
  // raw JSON marker must disappear while its digest line survives.
  capabilityFor: (tool: string) => ({
    digest: () => `${tool} digest line`,
  }),
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

const TOOL_CALL = (tool: string) => JSON.stringify({ action: 'tool', tool, args: { marker: `RAW_ARGS_${tool}` } });
const FINAL = JSON.stringify({ action: 'final', message: 'All done.' });

// Each tool's raw result JSON carries a unique marker so we can tell the raw
// JSON apart from its digest line in the assertions below.
function resultFor(tool: string) {
  return { ok: true, result: { marker: `RAW_RESULT_${tool}` } };
}

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runToolMock.mockReset();
});

describe('route-pass calls in both loops send a pruned transcript', () => {
  it('runAgent (runAgentImpl): the last route-pass call omits earlier tool-call JSON and the oldest observation\'s raw body', async () => {
    generateChat.mockResolvedValueOnce(TOOL_CALL('listTags'));
    generateChat.mockResolvedValueOnce(TOOL_CALL('listLeads'));
    generateChat.mockResolvedValueOnce(TOOL_CALL('getPersona'));
    generateChat.mockResolvedValueOnce(FINAL);
    runToolMock.mockImplementation(async (tool: string) => resultFor(tool));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'do three things', conversationId: 'conv-1' });
    expect(res.status).toBe('done');

    // The persisted transcript (what saveConversation writes) is UNTOUCHED —
    // it still carries the full raw envelopes and full observations.
    const storedJoined = res.transcript.map((m) => m.content).join('\n');
    expect(storedJoined).toContain('RAW_ARGS_listTags');
    expect(storedJoined).toContain('RAW_RESULT_listTags');

    // The 4th (final) generateChat call is the one that matters: by then,
    // listTags's tool-call envelope and its observation are old enough to be
    // pruned (only the 2 most recent observations — listLeads, getPersona —
    // survive in full).
    expect(generateChat).toHaveBeenCalledTimes(4);
    const lastCallMessages = generateChat.mock.calls[3][0].messages as { role: string; content: string }[];
    const joined = lastCallMessages.map((m) => m.content).join('\n');

    expect(joined).not.toContain('RAW_ARGS_listTags'); // old tool-call envelope collapsed
    expect(joined).not.toContain('RAW_RESULT_listTags'); // old observation's raw JSON reduced away
    expect(joined).toContain('listTags digest line'); // its digest line survives
    expect(joined).toContain('[called listTags]'); // its tool-call envelope collapsed to a narration

    // The 2 most recent observations are kept in full.
    expect(joined).toContain('RAW_RESULT_listLeads');
    expect(joined).toContain('RAW_RESULT_getPersona');

    // No `id` field ever reaches the wire, same guarantee toWireMessages gave.
    for (const m of lastCallMessages) expect(Object.keys(m).sort()).toEqual(['content', 'role']);
  });

  it('runAgentStream (runAgentStreamImpl): the same pruning applies', async () => {
    generateChat.mockResolvedValueOnce(TOOL_CALL('listTags'));
    generateChat.mockResolvedValueOnce(TOOL_CALL('listLeads'));
    generateChat.mockResolvedValueOnce(TOOL_CALL('getPersona'));
    generateChat.mockResolvedValueOnce(FINAL);
    runToolMock.mockImplementation(async (tool: string) => resultFor(tool));

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream({ accountId: 'acct-1', message: 'do three things', conversationId: 'conv-1' }, (e) => events.push(e));

    expect(generateChat).toHaveBeenCalledTimes(4);
    const lastCallMessages = generateChat.mock.calls[3][0].messages as { role: string; content: string }[];
    const joined = lastCallMessages.map((m) => m.content).join('\n');

    expect(joined).not.toContain('RAW_ARGS_listTags');
    expect(joined).not.toContain('RAW_RESULT_listTags');
    expect(joined).toContain('listTags digest line');
    expect(joined).toContain('[called listTags]');
    expect(joined).toContain('RAW_RESULT_listLeads');
    expect(joined).toContain('RAW_RESULT_getPersona');
    for (const m of lastCallMessages) expect(Object.keys(m).sort()).toEqual(['content', 'role']);
  });
});

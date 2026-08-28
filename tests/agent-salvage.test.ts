// FIX 1 (see the task spec this shipped under): a failed forced-final call
// must not throw away tool results that already succeeded this turn.
//
// Production evidence: a turn logged toolCalls: ["listTags","listLeads"],
// stepCount: 2, durationMs: 207477 — both tools succeeded, then the
// forced-final call failed, and the turn returned the bare generic apology
// with everything gathered thrown away.
//
// These drive the REAL runAgent / runAgentStream loops (not a
// reimplementation) — same harness as tests/agent-json-retry.test.ts — so
// this can only pass if the actual loop.ts salvage path runs.

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

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runToolMock.mockReset();
  warn.mockReset();
});

/** Drives the loop into forced-final the FAST way: call the same tool
 *  repeatedly so the duplicate-call guard (toolCalls[tool] >= 2, then two
 *  nudges) breaks out of the ReAct loop on its own — far cheaper in test time
 *  than exhausting MAX_STEPS or TURN_DEADLINE_MS, and it's a real path
 *  through the real loop, not a shortcut around it. */
function queueUpToForcedFinal(tool: string) {
  generateChat.mockResolvedValueOnce(DUP_TOOL_CALL(tool, 1));
  generateChat.mockResolvedValueOnce(DUP_TOOL_CALL(tool, 2));
  generateChat.mockResolvedValueOnce(DUP_TOOL_CALL(tool, 3)); // toolCalls[tool] now >= 2 -> nudge 1
  generateChat.mockResolvedValueOnce(DUP_TOOL_CALL(tool, 4)); // nudge 2 -> break to forced-final
}

describe('runAgent (JSON, non-streaming) — salvage after forced-final fails', () => {
  it('returns the gathered tool results, not the bare apology, when tools succeeded and forced-final throws', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { tags: ['vip', 'cold'] } });
    queueUpToForcedFinal('listTags');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'what tags do we have?', conversationId: 'conv-1' });

    expect(res.status).toBe('salvage');
    expect(res.message).not.toContain('I gathered the details but had trouble summarizing');
    expect(res.message).toContain('List Tags');
    expect(res.message).toContain('vip');
  });

  it('falls back to the plain apology when there is nothing to salvage (zero successful tool calls)', async () => {
    // Every call to listTags itself fails (res.ok:false), so no step in the
    // transcript ever has a non-ERROR observation to salvage from.
    runToolMock.mockResolvedValue({ ok: false, error: 'downstream unavailable' });
    queueUpToForcedFinal('listTags');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'what tags do we have?', conversationId: 'conv-1' });

    expect(res.status).toBe('error');
    expect(res.message).toBe('I gathered the details but had trouble summarizing. Please ask again a bit more specifically.');
  });

  it('never fabricates: the salvage message contains only observations that are actually in the step list', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { tags: ['a-real-tag-xyz'] } });
    queueUpToForcedFinal('listTags');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'tags?', conversationId: 'conv-1' });

    expect(res.status).toBe('salvage');
    const succeededObservations = res.steps
      .filter((s) => s.tool && typeof s.observation === 'string' && !s.observation.startsWith('ERROR:'))
      .map((s) => s.observation as string);
    expect(succeededObservations.length).toBeGreaterThan(0);
    // Every line of fact in the message traces back to a real observation —
    // spot-check the concrete value the tool actually returned.
    expect(res.message).toContain('a-real-tag-xyz');
    for (const obs of succeededObservations) {
      // The (possibly truncated) observation text must itself be a prefix of
      // what actually came back — nothing invented in its place.
      expect(obs.startsWith('{"tags":["a-real-tag-xyz"]}')).toBe(true);
    }
  });
});

describe('runAgentStream (streaming) — salvage after forced-final fails (must match runAgentImpl)', () => {
  it('emits a final event carrying the salvage message, flagged salvage:true, not the bare apology', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { leads: ['lead-42'] } });
    queueUpToForcedFinal('listLeads');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'which leads?', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    const finalEvents = events.filter((e) => e.type === 'final');
    expect(finalEvents.length).toBe(1);
    expect(finalEvents[0].salvage).toBe(true);
    expect(finalEvents[0].message).toContain('List Leads');
    expect(finalEvents[0].message).toContain('lead-42');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('falls back to the plain error event when there is nothing to salvage', async () => {
    runToolMock.mockResolvedValue({ ok: false, error: 'downstream unavailable' });
    queueUpToForcedFinal('listLeads');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'which leads?', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.message).toBe('I gathered the details but had trouble summarizing. Please ask again a bit more specifically.');
    expect(events.some((e) => e.type === 'final')).toBe(false);
  });
});

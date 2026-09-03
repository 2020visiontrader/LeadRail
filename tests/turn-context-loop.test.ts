// Both agent loops (runAgentImpl / runAgentStreamImpl in lib/agent/loop.ts)
// must render input.turnContext identically — CLAUDE.md: "Two agent loops
// exist ... and must stay identical. A fix applied to only one is not
// applied." This file proves that for the turn-context wiring specifically,
// following the same harness as tests/agent-deadline-propagation.test.ts
// (mocked generateChat, inspect the `system` string each call received).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const runTool = vi.fn(async (..._a: any[]) => ({ ok: true, result: { rows: [] } }));

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`probe${i}`, { title: `Probe ${i}`, run: vi.fn() }]),
  ),
  runTool: (...a: any[]) => runTool(...a),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  capabilityFor: () => ({ gate: 'read' }),
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
  createApproval: async () => null, consumeApprovalForExecution: vi.fn(),
  markApprovedByToolAndArgs: vi.fn(), recordExecutedApproval: vi.fn(),
  ApprovalExecutionError: class extends Error {},
}));
vi.mock('@/lib/approvals/grants', () => ({ consumeGrant: async () => null, isGrantable: () => false }));
vi.mock('@/lib/capabilities/delegation', () => ({
  beginDelegationScope: vi.fn(), endDelegationScope: vi.fn(), setDelegationContext: vi.fn(),
}));
vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: async () => ({ skillIds: [] }) }));
vi.mock('@/lib/credits', () => ({ markParseOutcome: vi.fn(), recordAiUsage: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));
vi.mock('@/lib/storage', () => ({ putPrivate: vi.fn(), signUrl: vi.fn(), ensurePrivateBucket: vi.fn() }));
vi.mock('@/lib/ai/deck', () => ({ extractDeckText: vi.fn(), isSupportedDeck: () => false }));

const FINAL = JSON.stringify({ action: 'final', message: 'Here is what I found.' });

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  generateChat.mockResolvedValue(FINAL);
  runTool.mockClear();
});

const SAMPLE_TURN_CONTEXT =
  'WHERE THE USER IS RIGHT NOW (client-reported, for orientation only — never repeat this back to them):\n- Page: leads\n- Selected (1): c1';

describe('turnContext rendering — both loops', () => {
  it('runAgent (non-streaming): the system prompt includes the turnContext block verbatim', async () => {
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'what do you see?', turnContext: SAMPLE_TURN_CONTEXT });
    expect(generateChat).toHaveBeenCalled();
    const system = generateChat.mock.calls[0][0].system as string;
    expect(system).toContain(SAMPLE_TURN_CONTEXT);
  });

  it('runAgentStream: the system prompt includes the SAME turnContext block', async () => {
    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'what do you see?', turnContext: SAMPLE_TURN_CONTEXT },
      (e) => events.push(e),
    );
    expect(generateChat).toHaveBeenCalled();
    const system = generateChat.mock.calls[0][0].system as string;
    expect(system).toContain(SAMPLE_TURN_CONTEXT);
  });

  it('both loops produce the IDENTICAL system prompt for the same input, turnContext included', async () => {
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'hi', turnContext: SAMPLE_TURN_CONTEXT });
    const nonStreamingSystem = generateChat.mock.calls[0][0].system as string;

    vi.resetModules();
    generateChat.mockReset();
    generateChat.mockResolvedValue(FINAL);
    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream({ accountId: 'acct-1', message: 'hi', turnContext: SAMPLE_TURN_CONTEXT }, (e) => events.push(e));
    const streamingSystem = generateChat.mock.calls[0][0].system as string;

    expect(streamingSystem).toBe(nonStreamingSystem);
  });

  it('omitting turnContext (the pre-existing behaviour) leaves the prompt exactly as before — no stray header', async () => {
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'hi' });
    const system = generateChat.mock.calls[0][0].system as string;
    expect(system).not.toContain('WHERE THE USER IS RIGHT NOW');
  });
});

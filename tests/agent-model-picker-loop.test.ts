// Composer model picker (Part 1) — the modelId reaches the REAL runAgent /
// runAgentStream loops (same harness as tests/persona-routing-loop.test.ts),
// not a reimplementation. CLAUDE.md: runAgentImpl and runAgentStreamImpl
// must stay identical, so every case runs against both.
//
// PRECEDENCE under test: an explicit user pick (input.modelId) wins over a
// persona's pinned model (persona.model_id), which wins over Auto (nothing
// sent — the router ladder decides). See the comment on
// RunAgentInput.modelId in lib/agent/loop.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const loadPersonaForAgent = vi.fn(async (..._a: any[]) => null as any);
const listPersonas = vi.fn(async (..._a: any[]) => [] as any[]);

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: {},
  runTool: vi.fn(),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  capabilityFor: () => undefined,
  toolsFromCapabilities: () => ({}),
}));
vi.mock('@/lib/capabilities/external-mcp', () => ({ loadExternalCapabilities: async () => [] }));

vi.mock('@/lib/agent/personas', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent/personas')>('@/lib/agent/personas');
  return {
    ...actual,
    loadPersonaForAgent: (...a: any[]) => loadPersonaForAgent(...a),
    resolveMentionedPersonas: async () => [],
    getCoordinator: async () => null,
    listPersonas: (...a: any[]) => listPersonas(...a),
  };
});

vi.mock('@/lib/agent/harvested-personas', () => ({ HARVESTED_PERSONA_TEMPLATES: [] }));
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

const FINAL = JSON.stringify({ action: 'final', message: 'Done.' });

const PINNED_PERSONA = {
  id: 'pinned-1', name: 'Pinned Persona', role: 'pinned-role',
  instructions: 'PINNED_PERSONA_INSTRUCTIONS', model_id: 'persona-model-row', tone: null,
  enabled: true, is_coordinator: false,
};

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  generateChat.mockResolvedValue(FINAL);
  loadPersonaForAgent.mockReset();
  loadPersonaForAgent.mockResolvedValue(null);
  listPersonas.mockReset();
  listPersonas.mockResolvedValue([]);
});

describe('runAgent — composer model picker', () => {
  it('Auto (no input.modelId) sends no modelId — unchanged behaviour', async () => {
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'help', conversationId: 'conv-1' });

    const call = generateChat.mock.calls[0][0];
    expect(call.modelId).toBeUndefined();
  });

  it('a user-picked modelId reaches the model call', async () => {
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'help', conversationId: 'conv-1', modelId: 'user-picked-row' });

    const call = generateChat.mock.calls[0][0];
    expect(call.modelId).toBe('user-picked-row');
  });

  it('a user pick beats a persona-pinned model', async () => {
    loadPersonaForAgent.mockResolvedValue(PINNED_PERSONA);
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({
      accountId: 'acct-1', message: 'help', conversationId: 'conv-1',
      personaId: 'pinned-1', modelId: 'user-picked-row',
    });

    const call = generateChat.mock.calls[0][0];
    expect(call.modelId).toBe('user-picked-row');
  });

  it('with no user pick, a persona-pinned model still wins over Auto', async () => {
    loadPersonaForAgent.mockResolvedValue(PINNED_PERSONA);
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'help', conversationId: 'conv-1', personaId: 'pinned-1' });

    const call = generateChat.mock.calls[0][0];
    expect(call.modelId).toBe('persona-model-row');
  });
});

describe('runAgentStream — composer model picker (must match runAgentImpl)', () => {
  it('Auto (no input.modelId) sends no modelId — unchanged behaviour', async () => {
    const { runAgentStream } = await import('@/lib/agent/loop');
    await runAgentStream({ accountId: 'acct-1', message: 'help', conversationId: 'conv-1' }, () => {});

    const call = generateChat.mock.calls[0][0];
    expect(call.modelId).toBeUndefined();
  });

  it('a user-picked modelId reaches the model call', async () => {
    const { runAgentStream } = await import('@/lib/agent/loop');
    await runAgentStream(
      { accountId: 'acct-1', message: 'help', conversationId: 'conv-1', modelId: 'user-picked-row' },
      () => {},
    );

    const call = generateChat.mock.calls[0][0];
    expect(call.modelId).toBe('user-picked-row');
  });

  it('a user pick beats a persona-pinned model', async () => {
    loadPersonaForAgent.mockResolvedValue(PINNED_PERSONA);
    const { runAgentStream } = await import('@/lib/agent/loop');
    await runAgentStream(
      {
        accountId: 'acct-1', message: 'help', conversationId: 'conv-1',
        personaId: 'pinned-1', modelId: 'user-picked-row',
      },
      () => {},
    );

    const call = generateChat.mock.calls[0][0];
    expect(call.modelId).toBe('user-picked-row');
  });

  it('with no user pick, a persona-pinned model still wins over Auto', async () => {
    loadPersonaForAgent.mockResolvedValue(PINNED_PERSONA);
    const { runAgentStream } = await import('@/lib/agent/loop');
    await runAgentStream(
      { accountId: 'acct-1', message: 'help', conversationId: 'conv-1', personaId: 'pinned-1' },
      () => {},
    );

    const call = generateChat.mock.calls[0][0];
    expect(call.modelId).toBe('persona-model-row');
  });
});

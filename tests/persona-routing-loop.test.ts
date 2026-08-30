// BACKLOG 5b — persona voice reaches the turn's system prompt through the
// REAL runAgent / runAgentStream loops (same harness as
// tests/agent-deadline-propagation.test.ts), not a reimplementation.
//
// Covers: the single-persona tie-break when routed skills name two different
// personas, and that an explicitly pinned personaId suppresses skill-derived
// routing entirely. CLAUDE.md: runAgentImpl and runAgentStreamImpl must stay
// identical, so every case runs against both.

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

// Real buildPersonaSystemBlock (pure) so the rendered block is realistic;
// only the DB-backed reads are mocked.
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

vi.mock('@/lib/agent/harvested-personas', () => ({
  HARVESTED_PERSONA_TEMPLATES: [
    {
      slug: 'seo-specialist', name: 'SEO Specialist', description: 'd', role: 'seo-specialist',
      instructions: 'SEO_SPECIALIST_TEMPLATE_INSTRUCTIONS', domain: 'shared',
      sourceRepo: 'x', sourceCommit: 'x', sourcePath: 'x', license: 'MIT',
    },
    {
      slug: 'content-creator', name: 'Content Creator', description: 'd', role: 'content-creator',
      instructions: 'CONTENT_CREATOR_TEMPLATE_INSTRUCTIONS', domain: 'shared',
      sourceRepo: 'x', sourceCommit: 'x', sourcePath: 'x', license: 'MIT',
    },
  ],
}));

const SKILL_NAMING_SEO = {
  slug: 'skill-a', name: 'Skill A',
  instructions: 'Do the thing.\n\n## Agents Used\n\n- **seo-specialist** — does SEO stuff',
};
const SKILL_NAMING_CONTENT_1 = {
  slug: 'skill-b', name: 'Skill B',
  instructions: 'Do another thing.\n\n## Agents Used\n\n- **content-creator** — writes content',
};
const SKILL_NAMING_CONTENT_2 = {
  slug: 'skill-c', name: 'Skill C',
  instructions: 'Yet another thing.\n\n## Agents Used\n\n- **content-creator** — writes more content',
};

let enabledSkills: any[] = [];
vi.mock('@/lib/skills/store', () => ({ loadEnabledSkillsForAgent: async () => enabledSkills }));

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

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  loadPersonaForAgent.mockReset();
  loadPersonaForAgent.mockResolvedValue(null);
  listPersonas.mockReset();
  listPersonas.mockResolvedValue([]);
  enabledSkills = [];
});

describe('runAgent — skill-derived persona voice (tie-break + single block)', () => {
  it('picks the persona named by the most routed skills, and only that one block reaches the system prompt', async () => {
    enabledSkills = [SKILL_NAMING_SEO, SKILL_NAMING_CONTENT_1, SKILL_NAMING_CONTENT_2];
    generateChat.mockResolvedValueOnce(FINAL);

    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'help', conversationId: 'conv-1' });

    const system: string = generateChat.mock.calls[0][0].system;
    expect(system).toContain('CONTENT_CREATOR_TEMPLATE_INSTRUCTIONS');
    expect(system).not.toContain('SEO_SPECIALIST_TEMPLATE_INSTRUCTIONS');
  });

  it('a pinned personaId suppresses skill-derived voice entirely', async () => {
    enabledSkills = [SKILL_NAMING_SEO, SKILL_NAMING_CONTENT_1, SKILL_NAMING_CONTENT_2];
    loadPersonaForAgent.mockResolvedValue({
      id: 'pinned-1', name: 'Pinned Persona', role: 'pinned-role',
      instructions: 'PINNED_PERSONA_INSTRUCTIONS', model_id: null, tone: null,
      enabled: true, is_coordinator: false,
    });
    generateChat.mockResolvedValueOnce(FINAL);

    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'help', conversationId: 'conv-1', personaId: 'pinned-1' });

    const system: string = generateChat.mock.calls[0][0].system;
    expect(system).toContain('PINNED_PERSONA_INSTRUCTIONS');
    expect(system).not.toContain('CONTENT_CREATOR_TEMPLATE_INSTRUCTIONS');
    expect(system).not.toContain('SEO_SPECIALIST_TEMPLATE_INSTRUCTIONS');
    // The skill-derived path never even ran a DB lookup once a pin won.
    expect(listPersonas).not.toHaveBeenCalled();
  });
});

describe('runAgentStream — skill-derived persona voice (must match runAgentImpl)', () => {
  it('picks the persona named by the most routed skills, and only that one block reaches the system prompt', async () => {
    enabledSkills = [SKILL_NAMING_SEO, SKILL_NAMING_CONTENT_1, SKILL_NAMING_CONTENT_2];
    generateChat.mockResolvedValueOnce(FINAL);

    const { runAgentStream } = await import('@/lib/agent/loop');
    await runAgentStream({ accountId: 'acct-1', message: 'help', conversationId: 'conv-1' }, () => {});

    const system: string = generateChat.mock.calls[0][0].system;
    expect(system).toContain('CONTENT_CREATOR_TEMPLATE_INSTRUCTIONS');
    expect(system).not.toContain('SEO_SPECIALIST_TEMPLATE_INSTRUCTIONS');
  });

  it('a pinned personaId suppresses skill-derived voice entirely', async () => {
    enabledSkills = [SKILL_NAMING_SEO, SKILL_NAMING_CONTENT_1, SKILL_NAMING_CONTENT_2];
    loadPersonaForAgent.mockResolvedValue({
      id: 'pinned-1', name: 'Pinned Persona', role: 'pinned-role',
      instructions: 'PINNED_PERSONA_INSTRUCTIONS', model_id: null, tone: null,
      enabled: true, is_coordinator: false,
    });
    generateChat.mockResolvedValueOnce(FINAL);

    const { runAgentStream } = await import('@/lib/agent/loop');
    await runAgentStream(
      { accountId: 'acct-1', message: 'help', conversationId: 'conv-1', personaId: 'pinned-1' },
      () => {},
    );

    const system: string = generateChat.mock.calls[0][0].system;
    expect(system).toContain('PINNED_PERSONA_INSTRUCTIONS');
    expect(system).not.toContain('CONTENT_CREATOR_TEMPLATE_INSTRUCTIONS');
    expect(listPersonas).not.toHaveBeenCalled();
  });
});

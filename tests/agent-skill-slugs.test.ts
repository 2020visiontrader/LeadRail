// GAP 1 (message_feedback.skill_slugs had no writer, migration 080). This
// drives the REAL runAgent/runAgentStream loops — not a reimplementation —
// and asserts that AgentResult.skillSlugs (non-streaming) and the streaming
// 'final' event's skillSlugs both carry the routed skill slugs for a turn
// that actually routed skills. CLAUDE.md: the two loops must stay identical,
// so both are exercised here with the same enabled-skills fixture.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();

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
vi.mock('@/lib/agent/personas', () => ({
  loadPersonaForAgent: async () => null,
  resolveMentionedPersonas: async () => [],
  getCoordinator: async () => null,
  selectPersonasForRequest: async () => [],
  buildPersonaSystemBlock: () => '',
  buildCoordinatorSystemBlock: () => '',
  parseMentions: () => [],
}));
// The fixture GAP 1 exists to prove: two enabled skills, under
// SKILL_ROUTING_THRESHOLD (8), so selectSkillsForTurn returns both without
// needing a hermesRoute call — exactly the common-case "account has a few
// skills enabled" path a real vote would be cast against.
vi.mock('@/lib/skills/store', () => ({
  loadEnabledSkillsForAgent: async () => ([
    { slug: 'lead-scoring', name: 'Lead scoring', instructions: 'Score leads.' },
    { slug: 'campaign-copy', name: 'Campaign copy', instructions: 'Write ad copy.' },
  ]),
}));
vi.mock('@/lib/agent/compose', () => ({ composeAnswer: async (a: any) => a?.draft ?? '' }));
vi.mock('@/lib/approvals/store', () => ({
  createApproval: async () => null,
  consumeApprovalForExecution: vi.fn(),
  markApprovedByToolAndArgs: vi.fn(),
  ApprovalExecutionError: class extends Error {},
}));
vi.mock('@/lib/capabilities/delegation', () => ({
  beginDelegationScope: vi.fn(), endDelegationScope: vi.fn(), setDelegationContext: vi.fn(),
}));
vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: async () => ({ skillIds: [] }) }));
vi.mock('@/lib/credits', () => ({ markParseOutcome: vi.fn(), recordAiUsage: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));

const FINAL = JSON.stringify({ action: 'final', message: 'All done.' });

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
});

describe('routed skill slugs reach the turn result (non-streaming)', () => {
  it('AgentResult.skillSlugs carries the routed slugs for a done turn', async () => {
    generateChat.mockResolvedValueOnce(FINAL);
    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'score my leads', conversationId: 'conv-1' });
    expect(res.status).toBe('done');
    expect(res.skillSlugs).toEqual(['lead-scoring', 'campaign-copy']);
  });
});

describe('routed skill slugs reach the turn result (streaming)', () => {
  it("the 'final' event carries the same routed slugs", async () => {
    generateChat.mockResolvedValueOnce(FINAL);
    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream({ accountId: 'acct-1', message: 'score my leads', conversationId: 'conv-1' }, (e) => events.push(e));
    const final = events.find((e) => e.type === 'final');
    expect(final).toBeTruthy();
    expect(final.skillSlugs).toEqual(['lead-scoring', 'campaign-copy']);
  });
});

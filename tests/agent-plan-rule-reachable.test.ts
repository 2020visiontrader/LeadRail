// THE FINDING this test protects against: `agent_plans` had zero rows in
// production because the only instruction telling the model to call
// createPlan lived inside the `planOnly` branch of systemPrompt() — a
// DYNAMIC section present only when plan mode is toggled on for that turn.
// On an ordinary turn nothing told the model planning was even an option:
// createPlan was discoverable only as one line inside the full tool catalog,
// and it was called zero times across 274 logged turns.
//
// This file cannot test whether the model CHOOSES to plan — that is model
// judgement and needs a live call. What it tests is that the instruction is
// REACHABLE: present in the system prompt built for an ordinary turn (plan
// mode off), for BOTH runAgent and runAgentStream (CLAUDE.md requires the
// two loops to stay identical), and that plan mode's own "do NOT do the
// work" text still appears — and is not contradicted — when plan mode is on.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const runTool = vi.fn();

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: { listLeads: { title: 'List leads', sensitive: false } },
  runTool: (...a: any[]) => runTool(...a),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  capabilityFor: (n: string) => (n === 'listLeads' ? { gate: 'read' } : undefined),
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
}));
vi.mock('@/lib/approvals/grants', () => ({ consumeGrant: async () => null, isGrantable: () => false }));
vi.mock('@/lib/capabilities/delegation', () => ({
  beginDelegationScope: vi.fn(), endDelegationScope: vi.fn(), setDelegationContext: vi.fn(),
}));
vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: async () => ({ skillIds: [] }) }));
vi.mock('@/lib/credits', () => ({ markParseOutcome: vi.fn(), recordAiUsage: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));

// Distinctive fragment of the new standing rule, chosen so a substring match
// cannot false-positive against unrelated prompt text.
const PLAN_RULE_MARKER = 'WRITE A PLAN FIRST';

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runTool.mockReset();
});

describe('the planning standing rule is reachable on an ordinary turn', () => {
  it('runAgent (non-streaming loop): plan mode off/absent still gets the rule', async () => {
    let system = '';
    generateChat.mockImplementationOnce(async (a: any) => { system = a.system; return JSON.stringify({ action: 'final', message: 'hi' }); });
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'hello', conversationId: 'conv-1' });

    expect(system).toContain(PLAN_RULE_MARKER);
    // It must give a concrete threshold, not vague encouragement.
    expect(system).toMatch(/more than a handful of tool calls/);
    // And it must say when NOT to plan.
    expect(system).toMatch(/how many leads do I have/);
    // And it must point at createPlan's batch-step shape rather than restate it.
    expect(system).toContain('{ title, over: [...] }');
  });

  it('runAgentStream (streaming loop): plan mode off/absent still gets the rule', async () => {
    let system = '';
    generateChat.mockImplementationOnce(async (a: any) => { system = a.system; return JSON.stringify({ action: 'final', message: 'hi' }); });
    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream({ accountId: 'acct-1', message: 'hello', conversationId: 'conv-1' }, (e) => events.push(e));

    expect(system).toContain(PLAN_RULE_MARKER);
    expect(events.find((e) => e.type === 'final')).toBeTruthy();
  });

  it('the rule lives in the STATIC section (present even with planOnly explicitly false)', async () => {
    let system = '';
    generateChat.mockImplementationOnce(async (a: any) => { system = a.system; return JSON.stringify({ action: 'final', message: 'hi' }); });
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'hello', conversationId: 'conv-1', planOnly: false } as any);

    expect(system).toContain(PLAN_RULE_MARKER);
  });
});

describe('plan mode text is unaffected and not contradicted by the new standing rule', () => {
  it('runAgent with planOnly true still gets the plan-mode "do NOT do the work" text, plus the standing rule', async () => {
    let system = '';
    generateChat.mockImplementationOnce(async (a: any) => { system = a.system; return JSON.stringify({ action: 'final', message: 'Here is the plan.' }); });
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'plan the outreach for these 13 companies', conversationId: 'conv-1', planOnly: true } as any);

    expect(system).toContain('PLAN MODE IS ON FOR THIS TURN. Do NOT do the work.');
    expect(system).toContain(PLAN_RULE_MARKER);
    // The standing rule names its own exception for plan mode, so the two
    // do not read as contradictory instructions in the same prompt.
    expect(system).toMatch(/if PLAN MODE is on for this turn, stop after createPlan/);
  });

  it('runAgentStream with planOnly true still gets the plan-mode text, plus the standing rule', async () => {
    let system = '';
    generateChat.mockImplementationOnce(async (a: any) => { system = a.system; return JSON.stringify({ action: 'final', message: 'Here is the plan.' }); });
    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream({ accountId: 'acct-1', message: 'plan the outreach for these 13 companies', conversationId: 'conv-1', planOnly: true } as any, (e) => events.push(e));

    expect(system).toContain('PLAN MODE IS ON FOR THIS TURN. Do NOT do the work.');
    expect(system).toContain(PLAN_RULE_MARKER);
  });
});

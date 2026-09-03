// WIRING tests for lib/agent/claim-check.ts — proves the loop actually ROUTES
// a final answer through checkClaims before the user sees it, in both
// runAgentImpl and runAgentStreamImpl. tests/claim-check.test.ts proves the
// module's own behavior; this file is the half that module cannot prove
// about itself (CLAUDE.md: "this branch has twice shipped tests that pinned
// a CALL rather than the BEHAVIOUR" — so this asserts on the actual returned/
// emitted MESSAGE, never on whether checkClaims was called).
//
// These drive the REAL runAgent / runAgentStream loops (not a
// reimplementation), same harness as tests/agent-salvage.test.ts.
//
// PRODUCTION INCIDENT, 2026-09-02 14:28 UTC: a turn whose ledger held only
// `draftOutreach` produced "The last batch already went out to all 13
// marketing and e-commerce agency contacts." That is the fixture below.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const generateChat = vi.fn();
const runToolMock = vi.fn();
const composeAnswerMock = vi.fn(async (a: any, _onDelta?: any) => a?.draft ?? '');

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
    sendEmail: { title: 'Send email', sensitive: true },
    // Non-sensitive stand-in so a test can prove a genuinely EXECUTED "send"
    // category tool backs a claim without going through the approval flow
    // (sendEmail above is sensitive and, with no grant configured, would only
    // ever be proposed — never actually run — in this harness).
    sendOutreachEmailNow: { title: 'Send outreach email (test-only, non-sensitive)', sensitive: false },
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
// composeAnswer is mocked as a passthrough that returns the route pass's
// draft verbatim — the whole point being that compose faithfully "polishes"
// (here: leaves untouched) whatever the draft claims, exactly as the incident
// report says it does. The check under test must catch the claim AFTER this.
vi.mock('@/lib/agent/compose', () => ({ composeAnswer: (a: any, onDelta?: any) => composeAnswerMock(a, onDelta) }));
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

// The fabricated claim from the actual production incident.
const FABRICATED_DRAFT =
  'The last batch already went out to all 13 marketing and e-commerce agency contacts.';

const FINAL_CALL = (message: string) =>
  JSON.stringify({ action: 'final', message });

const TOOL_THEN_FINAL = (message: string) => [
  JSON.stringify({ action: 'tool', tool: 'draftOutreach', args: { leadIds: ['l1'] } }),
  FINAL_CALL(message),
];

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runToolMock.mockReset();
  composeAnswerMock.mockClear();
  runToolMock.mockResolvedValue({ ok: true, result: { drafted: 13 } });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('runAgent (non-streaming) — routes the final answer through claim-check', () => {
  it('corrects a fabricated "already went out" claim when only draftOutreach ran this turn', async () => {
    const [step1, step2] = TOOL_THEN_FINAL(FABRICATED_DRAFT);
    generateChat.mockResolvedValueOnce(step1).mockResolvedValueOnce(step2);

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'rework the drafts', conversationId: 'conv-1' });

    expect(res.status).toBe('done');
    expect(res.message).not.toMatch(/already went out/i);
    expect(res.message).not.toContain('13 marketing');
    // The persisted transcript must carry the corrected text too, not the
    // fabricated draft — a later turn builds on what the user was shown.
    const lastAssistant = res.transcript[res.transcript.length - 1];
    expect(lastAssistant.content).toBe(res.message);
  });

  it('leaves a genuinely supported claim untouched end-to-end', async () => {
    const supported = 'Your 13 emails have been sent to the marketing and e-commerce contacts.';
    generateChat
      .mockResolvedValueOnce(JSON.stringify({ action: 'tool', tool: 'sendOutreachEmailNow', args: {} }))
      .mockResolvedValueOnce(FINAL_CALL(supported));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'send them', conversationId: 'conv-1' });

    expect(res.status).toBe('done');
    expect(res.message).toBe(supported);
  });

  it('still corrects the claim when compose is disabled (AGENT_COMPOSE=0, fallback draft path)', async () => {
    // resetModules() in beforeEach already cleared loop.ts's module-level
    // AGENT_COMPOSE const from any prior test; setting the env var now, before
    // this test's dynamic import, is what that const reads at load time.
    // Every other collaborator stays the SAME top-level mock — only the env
    // and the fresh import differ from the first test in this file.
    process.env.AGENT_COMPOSE = '0';

    const [step1, step2] = TOOL_THEN_FINAL(FABRICATED_DRAFT);
    generateChat.mockResolvedValueOnce(step1).mockResolvedValueOnce(step2);

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'rework the drafts', conversationId: 'conv-1' });

    expect(res.status).toBe('done');
    expect(res.message).not.toMatch(/already went out/i);
    // Proves the check ran on the FALLBACK draft, not merely that compose
    // (which would have been a no-op passthrough anyway) never touched it.
    expect(composeAnswerMock).not.toHaveBeenCalled();
  });
});

describe('runAgentStream (streaming) — routes the final EMITTED event through claim-check', () => {
  it('corrects the fabricated claim in the terminal "final" event, not just the return value', async () => {
    const [step1, step2] = TOOL_THEN_FINAL(FABRICATED_DRAFT);
    generateChat.mockResolvedValueOnce(step1).mockResolvedValueOnce(step2);

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'rework the drafts', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    const final = events.find((e) => e.type === 'final');
    expect(final).toBeDefined();
    expect(final.message).not.toMatch(/already went out/i);
    expect(final.message).not.toContain('13 marketing');
    // The transcript carried on the final event must match what was emitted —
    // the "authoritative" text, per stream-outcome.ts's terminal-event
    // contract, not the pre-check draft.
    const lastAssistant = final.transcript[final.transcript.length - 1];
    expect(lastAssistant.content).toBe(final.message);
  });
});

// PRODUCTION COMPLAINT: delegates in a fan-out turn came back to the user as
// two separate "### Name" persona blocks instead of one unified answer, and
// the owner said the personas "are not taken in full context as they go to
// research". Two independent defects in lib/agent/loop.ts, both diagnosed
// from a production trace:
//
//   FIX 1 (this file) — synthesizeCoordinatorAnswer's system prompt already
//   asks the model to "Reconcile overlaps and disagreements; do not just
//   concatenate", but the generateChat call that runs it passed `accountId`
//   ONLY inside the `coordinator.model_id` branch, carried no `task` tag, and
//   hard-pinned `model: AGENT_OPENCODE_MODEL` — the dead last-resort tier.
//   So synthesis silently failed on almost every ordinary fan-out (no
//   coordinator model override) and fell back to concatenation — which is
//   exactly the "two separate persona blocks" the owner saw. This is the
//   SAME shape of defect fixed at the forced-final call sites in 8d41f2b;
//   these tests follow that file's pattern (tests/agent-forced-final-routing.test.ts)
//   and drive the REAL fan-out through runAgent/runAgentStream rather than
//   re-implementing synthesizeCoordinatorAnswer's control flow.
//
//   FIX 2 (delegateContext's per-delegate budget) is covered separately in
//   tests/coordinator-fanout-comprehension.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const runTool = vi.fn();
const warn = vi.fn();

const COORDINATOR = { id: 'coord-1', name: 'Ada', role: 'Coordinator', is_coordinator: true, enabled: true, model_id: null };
const MILO = { id: 'p-milo', name: 'Milo', role: 'Copywriter', is_coordinator: false, enabled: true, model_id: null };
const EZRA = { id: 'p-ezra', name: 'Ezra', role: 'Lifecycle', is_coordinator: false, enabled: true, model_id: null };

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: (...a: any[]) => warn(...a), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: {},
  runTool: (...a: any[]) => runTool(...a),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  capabilityFor: () => undefined,
  toolsFromCapabilities: () => ({}),
}));
vi.mock('@/lib/capabilities/external-mcp', () => ({ loadExternalCapabilities: async () => [] }));
vi.mock('@/lib/agent/personas', () => ({
  loadPersonaForAgent: async () => null,
  resolveMentionedPersonas: async () => [MILO, EZRA],
  getCoordinator: async () => COORDINATOR,
  selectPersonasForRequest: async () => [],
  buildPersonaSystemBlock: () => '',
  buildCoordinatorSystemBlock: () => 'You are the coordinator, Ada.',
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
vi.mock('@/lib/storage', () => ({
  putPrivate: vi.fn(), signUrl: vi.fn(), ensurePrivateBucket: vi.fn(),
}));
vi.mock('@/lib/ai/deck', () => ({ extractDeckText: vi.fn(), isSupportedDeck: () => false }));

const DELEGATE_FINAL = JSON.stringify({ action: 'final', message: 'Delegate answer.' });
const SYNTHESIS_MARKER = 'GROUNDING RULE MARKER'; // unused directly; matched by system text below

/** Every delegate call answers with DELEGATE_FINAL. The LAST generateChat
 *  call of the turn is the synthesis pass — identified by its system prompt
 *  containing the grounding-rule sentence synthesizeCoordinatorAnswer always
 *  includes, not by call order (which would be fragile against unrelated
 *  loop changes). */
function findSynthesisCall() {
  const call = generateChat.mock.calls
    .map((c) => c[0])
    .find((c) => String(c?.system || '').includes('CRITICAL — grounding rule'));
  expect(call).toBeTruthy();
  return call;
}

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  generateChat.mockResolvedValue(DELEGATE_FINAL); // delegates' own route passes
  runTool.mockReset();
  warn.mockReset();
});

describe('synthesizeCoordinatorAnswer routing (runAgent, non-streaming)', () => {
  it('passes accountId on the synthesis call even with no coordinator model override', async () => {
    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({
      accountId: 'acct-1',
      message: 'draft the campaign',
      personaMentions: ['Milo', 'Ezra'],
    });
    expect(res.status).toBe('done');
    const synthesisCall = findSynthesisCall();
    expect(synthesisCall.accountId).toBe('acct-1');
  });

  it('tags the synthesis call with a substantive task and does not hard-pin a model', async () => {
    await (await import('@/lib/agent/loop')).runAgent({
      accountId: 'acct-1',
      message: 'draft the campaign',
      personaMentions: ['Milo', 'Ezra'],
    });
    const synthesisCall = findSynthesisCall();
    expect(synthesisCall.task).toBe('draft');
    expect(synthesisCall.model).toBeUndefined();
  });
});

describe('synthesizeCoordinatorAnswer routing (runAgentStream, streaming)', () => {
  it('passes accountId and a substantive task on the synthesis call, no coordinator model override', async () => {
    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'draft the campaign', personaMentions: ['Milo', 'Ezra'] },
      (e) => events.push(e),
    );
    expect(events.some((e) => e.type === 'final')).toBe(true);
    const synthesisCall = findSynthesisCall();
    expect(synthesisCall.accountId).toBe('acct-1');
    expect(synthesisCall.task).toBe('draft');
    expect(synthesisCall.model).toBeUndefined();
  });
});

describe('synthesis failure visibility — the silent-fallback fix', () => {
  it('logs a warning naming the cause AND still returns the concatenation when synthesis returns empty', async () => {
    // Delegates answer normally; the LAST call (synthesis, matched by its
    // grounding-rule system text) returns an empty string.
    generateChat.mockImplementation(async (args: any) => {
      if (String(args?.system || '').includes('CRITICAL — grounding rule')) return '   '; // whitespace-only -> trimmed empty
      return DELEGATE_FINAL;
    });
    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({
      accountId: 'acct-1',
      message: 'draft the campaign',
      personaMentions: ['Milo', 'Ezra'],
    });
    expect(res.status).toBe('done');
    // Fallback concatenation: both delegates' names and messages still present.
    expect(res.message).toContain('Milo');
    expect(res.message).toContain('Ezra');
    expect(res.message).toContain('Delegate answer.');
    // The failure is now VISIBLE, not silent.
    expect(warn).toHaveBeenCalledWith(
      'coordinator synthesis returned empty, falling back to concatenation',
      expect.objectContaining({ accountId: 'acct-1', coordinator: 'Ada' }),
    );
  });

  it('logs a warning naming the cause AND still returns the concatenation when the synthesis call throws', async () => {
    generateChat.mockImplementation(async (args: any) => {
      if (String(args?.system || '').includes('CRITICAL — grounding rule')) throw new Error('boom: provider unavailable');
      return DELEGATE_FINAL;
    });
    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({
      accountId: 'acct-1',
      message: 'draft the campaign',
      personaMentions: ['Milo', 'Ezra'],
    });
    expect(res.status).toBe('done');
    expect(res.message).toContain('Milo');
    expect(res.message).toContain('Ezra');
    expect(warn).toHaveBeenCalledWith(
      'coordinator synthesis call failed, falling back to concatenation',
      expect.objectContaining({ accountId: 'acct-1', coordinator: 'Ada', error: expect.stringContaining('boom') }),
    );
  });
});

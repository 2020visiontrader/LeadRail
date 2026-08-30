// THE FIX, points 5 and 6: lib/agent/loop.ts computes ONE absolute deadline
// per turn (computeTurnDeadline) and must pass it into every generateChat call
// in that turn — step loop, forced-final, and (for a fan-out) each delegate's
// own sub-turn plus the synthesis call. A delegate's deadline must never
// exceed its parent's.
//
// tests/turn-deadline.test.ts already proves the CLOCK stops the turn. These
// prove the VALUE that clock produces actually reaches every model call —
// the wiring THE FIX adds on top of the pre-existing deadline check.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeTurnDeadline } from '@/lib/agent/loop';

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

const COORDINATOR = { id: 'coord-1', name: 'Ada', role: 'Coordinator', is_coordinator: true, enabled: true, model_id: null };
const MILO = { id: 'p-milo', name: 'Milo', role: 'Copywriter', is_coordinator: false, enabled: true, model_id: null };
const EZRA = { id: 'p-ezra', name: 'Ezra', role: 'Lifecycle', is_coordinator: false, enabled: true, model_id: null };

vi.mock('@/lib/agent/personas', () => ({
  loadPersonaForAgent: async () => null,
  resolveMentionedPersonas: async () => [MILO, EZRA],
  getCoordinator: async () => COORDINATOR,
  selectPersonasForRequest: async () => [],
  buildPersonaSystemBlock: () => '',
  buildCoordinatorSystemBlock: () => 'You are the coordinator.',
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

let toolSeq = 0;
const toolCall = () => JSON.stringify({
  thought: 'looking', action: 'tool', tool: `probe${toolSeq++}`, args: {},
});
const FINAL = JSON.stringify({ action: 'final', message: 'Here is what I found.' });

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runTool.mockClear();
  toolSeq = 0;
});

describe('computeTurnDeadline', () => {
  it("with no parent deadline, returns this turn's own full TURN_DEADLINE_MS budget", () => {
    const before = Date.now();
    const d = computeTurnDeadline({ accountId: 'a' });
    const after = Date.now();
    // Default TURN_DEADLINE_MS is 5 minutes; allow the test's own execution
    // slack rather than asserting an exact millisecond.
    expect(d).toBeGreaterThanOrEqual(before + 4 * 60 * 1000);
    expect(d).toBeLessThanOrEqual(after + 5 * 60 * 1000 + 1000);
  });

  it("clamps to the PARENT's deadline when that is sooner — a delegate can never outlive its parent", () => {
    const parentDeadline = Date.now() + 30_000; // parent nearly out of budget
    const d = computeTurnDeadline({ accountId: 'a', deadlineAt: parentDeadline });
    expect(d).toBe(parentDeadline);
  });

  it("does NOT clamp when the parent's deadline is LATER than this turn's own default", () => {
    const farParent = Date.now() + 999 * 60 * 1000; // absurdly generous parent
    const d = computeTurnDeadline({ accountId: 'a', deadlineAt: farParent });
    expect(d).toBeLessThan(farParent); // this turn's OWN (shorter) budget wins
  });

  it('never exceeds the parent even when the parent is already almost expired', () => {
    const almostGone = Date.now() + 5; // parent has 5ms left
    const d = computeTurnDeadline({ accountId: 'a', deadlineAt: almostGone });
    expect(d).toBe(almostGone);
  });
});

describe('every model call in an ordinary turn carries the SAME absolute deadline', () => {
  it('non-streaming: step-loop calls and the forced-final call all match', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      return calls > 3 ? FINAL : toolCall(); // forces a forced-final-shaped final on step 4
    });
    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'find me some leads' });

    expect(res.status).toBe('done');
    const deadlines = generateChat.mock.calls.map((c) => c[0].deadlineAt);
    expect(deadlines.length).toBeGreaterThan(1);
    expect(deadlines.every((d) => typeof d === 'number')).toBe(true);
    expect(new Set(deadlines).size).toBe(1); // every call in the turn used the SAME deadline
  });

  it('streaming: identical property holds for runAgentStream', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      return calls > 3 ? FINAL : toolCall();
    });
    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream({ accountId: 'acct-1', message: 'find me some leads' }, (e) => events.push(e));

    expect(events.some((e) => e.type === 'final')).toBe(true);
    const deadlines = generateChat.mock.calls.map((c) => c[0].deadlineAt);
    expect(deadlines.length).toBeGreaterThan(1);
    expect(new Set(deadlines).size).toBe(1);
  });
});

describe('the turn deadline reaches capabilities that can spawn sub-runs', () => {
  // REPLACES a fan-out test. The coordinator fan-out used to be the only path
  // that handed its deadline to a sub-run; it is gone, and askSpecialist is now
  // the only way to spawn one. Without this the sub-run computes a fresh full
  // budget and can legally outlive the turn that spawned it — the exact defect
  // the deleted test pinned, on the path that survived it.
  //
  // This is the LOOP half of the property: every tool call carries the turn's
  // deadline on its server-derived context. The DELEGATION half — askSpecialist
  // actually passing that value down to runAgent — is pinned in
  // tests/delegation-context-isolation.test.ts, where the delegation module is
  // not mocked away.
  it('puts the turn deadline on the tool context, matching the model calls', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      return calls > 2 ? FINAL : toolCall();
    });
    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'find me some leads' });

    expect(res.status).toBe('done');
    expect(runTool).toHaveBeenCalled();

    // runTool(tool, accountId, args, extraTools, extraCaps, brandId, toolCtx)
    const ctxs = runTool.mock.calls.map((c: any[]) => c[6]);
    expect(ctxs.length).toBeGreaterThan(0);
    for (const ctx of ctxs) expect(typeof ctx?.deadlineAt).toBe('number');

    // It is the SAME instant the turn's own model calls measure against — not a
    // second clock started when the tool happened to run.
    const modelDeadlines = new Set(generateChat.mock.calls.map((c) => c[0].deadlineAt));
    expect(modelDeadlines.size).toBe(1);
    expect(ctxs[0].deadlineAt).toBe([...modelDeadlines][0]);
  });

  it('streaming: identical property holds for runAgentStream', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      return calls > 2 ? FINAL : toolCall();
    });
    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream({ accountId: 'acct-1', message: 'find me some leads' }, (e) => events.push(e));

    expect(events.some((e) => e.type === 'final')).toBe(true);
    const ctxs = runTool.mock.calls.map((c: any[]) => c[6]);
    expect(ctxs.length).toBeGreaterThan(0);
    const modelDeadlines = new Set(generateChat.mock.calls.map((c) => c[0].deadlineAt));
    expect(modelDeadlines.size).toBe(1);
    expect(ctxs[0].deadlineAt).toBe([...modelDeadlines][0]);
  });
});

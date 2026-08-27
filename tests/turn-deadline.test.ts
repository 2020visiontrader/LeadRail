// MAX_STEPS bounded how many times a turn may loop. Nothing bounded how long.
//
// Those are different limits and only one was set, so a turn whose model calls
// were each slow ran until it exhausted its steps: 6, 9 and 18 minutes observed
// in production, with the person who asked watching a spinner the whole time.
// Eighteen minutes is not a slow answer, it is an abandoned one.
//
// The deadline must do two things, and the second is what makes it safe:
// stop the turn, and still ANSWER from what was gathered rather than throwing
// the work away.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const runTool = vi.fn(async () => ({ ok: true, result: { rows: [] } }));
const warn = vi.fn();
let now = 1_000_000;

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: (...a: any[]) => warn(...a), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`probe${i}`, { title: `Probe ${i}`, run: vi.fn() }]),
  ),
  runTool: (...a: any[]) => runTool(),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  capabilityFor: () => ({ gate: 'read' }),
  toolsFromCapabilities: () => ({}),
}));
vi.mock('@/lib/capabilities/external-mcp', () => ({ loadExternalCapabilities: async () => [] }));
vi.mock('@/lib/agent/personas', () => ({
  loadPersonaForAgent: async () => null, resolveMentionedPersonas: async () => [],
  getCoordinator: async () => null, selectPersonasForRequest: async () => [],
  buildPersonaSystemBlock: () => '', buildCoordinatorSystemBlock: () => '', parseMentions: () => [],
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

// A DISTINCT TOOL EVERY STEP, which is what it takes to isolate the deadline.
//
// The loop force-finals after two duplicate nudges, and it counts duplicates
// two ways: a repeated tool+args signature, AND a third call to the same tool
// whatever the args (`toolCalls[tool] >= 2`). A turn that keeps calling one
// tool therefore ends on its own at roughly the step a 5-minute deadline would
// have ended it — so a deadline test written that way goes green with the
// deadline deleted. This one did, twice: first with a fixed envelope, then
// again with varied args, which only dodged the signature half of the guard.
// Rotating tools is the only version where removing the deadline turns these
// red.
let toolSeq = 0;
const toolCall = () => JSON.stringify({
  thought: 'looking', action: 'tool', tool: `probe${toolSeq++}`, args: {},
});
const FINAL = JSON.stringify({ action: 'final', message: 'Here is what I found.' });

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runTool.mockClear();
  warn.mockReset();
  now = 1_000_000;
  toolSeq = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

async function run() {
  const { runAgent } = await import('@/lib/agent/loop');
  return runAgent({ accountId: 'acct-1', message: 'find me some leads' });
}

describe('a turn is bounded in TIME, not only in steps', () => {
  it('stops once the deadline passes instead of running out its steps', async () => {
    // Every model call "takes" two minutes. Without a wall clock this runs
    // until MAX_STEPS is exhausted — which is how an eighteen-minute turn
    // happens.
    generateChat.mockImplementation(async () => { now += 2 * 60 * 1000; return toolCall(); });
    await run();
    // 5-minute deadline / 2 minutes a call: a handful of steps, not sixteen.
    expect(generateChat.mock.calls.length).toBeLessThan(6);
  });

  it('still ANSWERS, from what it actually gathered', async () => {
    // The half of this that makes it safe. Stopping and throwing the work away
    // would just be a faster failure.
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      now += 2 * 60 * 1000;
      // The forced-final pass, once the loop breaks.
      return calls > 3 ? FINAL : toolCall();
    });
    const res = await run();
    expect(res.status).toBe('done');
    expect(res.message).toContain('Here is what I found.');
  });

  it('says why it stopped, so an 18-minute turn is diagnosable next time', async () => {
    generateChat.mockImplementation(async () => { now += 2 * 60 * 1000; return toolCall(); });
    await run();
    const hit = warn.mock.calls.find((c) => String(c[0]).includes('turn deadline reached'));
    expect(hit).toBeTruthy();
    expect(hit![1]).toMatchObject({ accountId: 'acct-1' });
  });

  it('keeps the tool results it had — the deadline is not a rollback', async () => {
    generateChat.mockImplementation(async () => { now += 2 * 60 * 1000; return toolCall(); });
    const res = await run();
    expect(runTool.mock.calls.length).toBeGreaterThan(0);
    expect(res.transcript.some((m) => m.content.startsWith('OBSERVATION:'))).toBe(true);
  });
});

describe('a normal turn is untouched', () => {
  it('does not interfere when the work finishes well inside the deadline', async () => {
    generateChat.mockImplementation(async () => { now += 1_000; return FINAL; });
    const res = await run();
    expect(res.status).toBe('done');
    expect(warn.mock.calls.find((c) => String(c[0]).includes('turn deadline'))).toBeUndefined();
  });

  it('lets a multi-step turn run its steps when each one is fast', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      now += 1_000;                 // fast calls
      return calls < 5 ? toolCall() : FINAL;
    });
    const res = await run();
    expect(res.status).toBe('done');
    expect(calls).toBeGreaterThanOrEqual(5);
  });
});

// The streaming loop is a SECOND, hand-maintained copy of the step loop. It has
// drifted from the non-streaming one before in this codebase, and it is the one
// every real chat turn actually runs — so a deadline present only in the copy
// nobody streams through would fix nothing that was observed.
describe('the streaming loop is bounded too, not just the one under test', () => {
  beforeEach(() => { vi.resetModules(); toolSeq = 0; });

  async function runStream() {
    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream({ accountId: 'acct-1', message: 'find me some leads' }, (e) => events.push(e));
    return events;
  }

  it('stops a slow streamed turn on the clock', async () => {
    generateChat.mockImplementation(async () => { now += 2 * 60 * 1000; return toolCall(); });
    await runStream();
    expect(generateChat.mock.calls.length).toBeLessThan(6);
    expect(warn.mock.calls.find((c) => String(c[0]).includes('turn deadline reached'))).toBeTruthy();
  });

  it('still emits a terminal event, so the UI is never left spinning', async () => {
    // The other half of the same bug: a bounded turn that ends without a
    // terminal event just moves the hang from the server to the browser.
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      now += 2 * 60 * 1000;
      return calls > 3 ? FINAL : toolCall();
    });
    const events = await runStream();
    expect(events.some((e) => ['final', 'needs_approval', 'error'].includes(e.type))).toBe(true);
  });
});

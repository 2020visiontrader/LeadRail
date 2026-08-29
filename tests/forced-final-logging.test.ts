// The forced-final pass — the call that turns gathered tool evidence into the
// user-facing answer once the step budget runs out — used to end on a bare
// `catch { /* fall through */ }` in both loop implementations. Two very
// different causes (the ladder exhausted vs. the model answering with
// malformed/off-schema JSON) produced the exact same generic
// "I gathered the details but had trouble summarizing" message, with nothing
// server-side to tell them apart. That is why the production incident this
// fixes went undiagnosed across many prompts: the log line is what makes the
// two causes distinguishable after the fact.
//
// CLAUDE.md: runAgentImpl and runAgentStreamImpl must stay identical — a fix
// applied to only one is not applied. Every case below runs against both.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const runTool = vi.fn(async () => ({ ok: true, result: { rows: [] } }));
const warn = vi.fn();

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

// A distinct tool every step, same reasoning as tests/turn-deadline.test.ts:
// a repeated tool/signature would force-final on its own duplicate-guard,
// which would make these tests pass whether or not the deadline/step-cap
// logic under test does anything.
let toolSeq = 0;
const toolCall = () => JSON.stringify({
  thought: 'looking', action: 'tool', tool: `probe${toolSeq++}`, args: {},
});

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runTool.mockClear();
  warn.mockReset();
  toolSeq = 0;
});

async function runNonStreaming() {
  const { runAgent } = await import('@/lib/agent/loop');
  return runAgent({ accountId: 'acct-1', message: 'find me some leads', maxSteps: 2 });
}

async function runStreaming() {
  const { runAgentStream } = await import('@/lib/agent/loop');
  const events: any[] = [];
  await runAgentStream({ accountId: 'acct-1', message: 'find me some leads', maxSteps: 2 }, (e) => events.push(e));
  return events;
}

describe('forced-final failure is logged, not swallowed (non-streaming)', () => {
  it('logs a distinct message when the model call itself throws (ladder exhausted)', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      throw new Error('OpenRouter returned an empty response');
    });
    const res = await runNonStreaming();
    // Both probe calls in this test succeed (runTool stub returns ok:true),
    // so the forced-final failure now salvages their results instead of
    // returning the bare apology — see tests/agent-salvage.test.ts for the
    // dedicated coverage of that behaviour. This file stays focused on what
    // it's for: the log line that makes the two forced-final failure causes
    // distinguishable.
    expect(res.status).toBe('salvage');
    expect(res.message).not.toContain('had trouble summarizing');

    const hit = warn.mock.calls.find((c) => String(c[0]).includes('forced-final call failed'));
    expect(hit).toBeTruthy();
    expect(hit![1]).toMatchObject({ accountId: 'acct-1' });
    expect(String(hit![1].error)).toContain('OpenRouter returned an empty response');

    // The OTHER cause must not also fire — the two are meant to be
    // distinguishable, not both logged for every failure.
    expect(warn.mock.calls.find((c) => String(c[0]).includes('produced no final action'))).toBeUndefined();
  });

  it('logs a distinct message when the call succeeds but the JSON is unusable (malformed/off-schema, not prose)', async () => {
    // A machine envelope, not prose: valid JSON with an `action` key but the
    // wrong shape. Must NOT be handed to the user as an answer — see
    // tests/agent-forced-final-prose.test.ts for the prose-is-accepted case
    // this file used to conflate with this one.
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return '{"action":"tool"}';
    });
    const res = await runNonStreaming();
    // Same salvage reasoning as the throw case above.
    expect(res.status).toBe('salvage');

    const hit = warn.mock.calls.find((c) => String(c[0]).includes('forced-final produced no final action'));
    expect(hit).toBeTruthy();
    expect(hit![1]).toMatchObject({ accountId: 'acct-1', path: 'salvage' });
    expect(String(hit![1].raw)).toContain('"action":"tool"');

    expect(warn.mock.calls.find((c) => String(c[0]).includes('forced-final call failed'))).toBeUndefined();
  });

  it('logs nothing extra when the forced-final call actually succeeds', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return JSON.stringify({ action: 'final', message: 'Here is what I found.' });
    });
    const res = await runNonStreaming();
    expect(res.status).toBe('done');
    expect(warn.mock.calls.find((c) => String(c[0]).includes('forced-final'))).toBeUndefined();
  });
});

describe('forced-final failure is logged, not swallowed (streaming — must match the non-streaming behaviour)', () => {
  it('logs a distinct message when the model call itself throws (ladder exhausted)', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      throw new Error('opencode: 401 unauthorized');
    });
    const events = await runStreaming();
    // Salvage twin of the non-streaming case above: both probe calls
    // succeeded, so this now emits `final` with salvage:true, not `error`.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const finalEvent = events.find((e) => e.type === 'final');
    expect(finalEvent?.salvage).toBe(true);

    const hit = warn.mock.calls.find((c) => String(c[0]).includes('forced-final call failed'));
    expect(hit).toBeTruthy();
    expect(String(hit![1].error)).toContain('401 unauthorized');
  });

  it('logs a distinct message when the call succeeds but the JSON is unusable (malformed/off-schema)', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return '{"action":"tool"}'; // valid JSON, wrong shape — no final action
    });
    const events = await runStreaming();
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const finalEvent = events.find((e) => e.type === 'final');
    expect(finalEvent?.salvage).toBe(true);

    const hit = warn.mock.calls.find((c) => String(c[0]).includes('forced-final produced no final action'));
    expect(hit).toBeTruthy();
  });
});

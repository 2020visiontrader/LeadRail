// THE BUG (production, app_logs, 4x in 3 hours on 2026-08-29): the
// forced-final call — the LAST call of a turn, whose only job is to answer
// in plain language — demanded a `{"action":"final","message":"..."}`
// envelope and threw the reply away whenever the model wrote good prose
// instead of wrapping it in JSON. The user was told the turn failed even
// though the model had already answered correctly.
//
// THE FIX: lib/agent/json-envelope.ts's extractForcedFinalProse distinguishes
// real prose (usable) from a machine envelope of the wrong shape, e.g.
// {"action":"tool",...} (NOT usable — never leaked to the user as a JSON
// blob). Applied at BOTH forced-final call sites (CLAUDE.md: runAgentImpl and
// runAgentStreamImpl must stay identical), so every case here runs against
// both.

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

// A distinct tool every step (same reasoning as tests/turn-deadline.test.ts):
// a repeated tool/signature would force-final on its own duplicate-guard,
// which would make these tests pass whether or not forced-final's prose
// handling does anything.
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

// Plain-prose answer a model would write when it forgets the JSON wrapper.
const GOOD_PROSE = 'Your top lead this week is Acme Corp, with a forty thousand dollar budget signal and three separate site visits in the last five days. I would prioritize outreach there first.';

describe('forced-final prose is used as the answer (non-streaming)', () => {
  it('case 1: plain prose -> that prose is the answer, turn is done, no apology prepended', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return GOOD_PROSE;
    });
    const res = await runNonStreaming();
    expect(res.status).toBe('done');
    expect(res.message).toBe(GOOD_PROSE);
    expect(res.message).not.toMatch(/trouble summarizing|couldn't complete|sorry/i);

    const hit = warn.mock.calls.find((c) => String(c[0]).includes('forced-final produced no final action'));
    expect(hit).toBeTruthy();
    expect(hit![1]).toMatchObject({ accountId: 'acct-1', path: 'prose_accepted' });
  });

  it('case 2: a proper {"action":"final","message":...} envelope is unchanged', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return JSON.stringify({ action: 'final', message: 'Here is what I found.' });
    });
    const res = await runNonStreaming();
    expect(res.status).toBe('done');
    expect(res.message).toBe('Here is what I found.');
    expect(warn.mock.calls.find((c) => String(c[0]).includes('forced-final'))).toBeUndefined();
  });

  it('case 3: a NON-final JSON envelope is rejected as prose and falls to salvage', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return JSON.stringify({ action: 'tool', tool: 'listLeads', args: { limit: 10 } });
    });
    const res = await runNonStreaming();
    // Must never be 'done' with the raw envelope as the message — that would
    // be a JSON blob reaching the user.
    expect(res.status).toBe('salvage');
    expect(res.message).not.toContain('"action"');
    expect(res.message).not.toContain('listLeads');

    const hit = warn.mock.calls.find((c) => String(c[0]).includes('forced-final produced no final action'));
    expect(hit).toBeTruthy();
    expect(hit![1]).toMatchObject({ path: 'salvage' });
  });

  it('case 4: empty/whitespace response -> salvage path, exactly as before', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return '   \n  ';
    });
    const res = await runNonStreaming();
    expect(res.status).toBe('salvage');
    const hit = warn.mock.calls.find((c) => String(c[0]).includes('forced-final produced no final action'));
    expect(hit).toBeTruthy();
    expect(hit![1]).toMatchObject({ path: 'salvage' });
  });

  it('case 5: a leading ```json fence with a dangling envelope fragment is stripped from what the user sees', async () => {
    let calls = 0;
    const raw = '```json\n{"action": "final", "mess\nActually, here is what I found: your best lead is Acme Corp, with strong intent signals from three site visits this week and a real budget behind it.';
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return raw;
    });
    const res = await runNonStreaming();
    expect(res.status).toBe('done');
    expect(res.message).not.toContain('```');
    expect(res.message).not.toContain('"action"');
    expect(res.message).not.toContain('{');
    expect(res.message).toContain('Acme Corp');
  });
});

describe('forced-final prose is used as the answer (streaming — must match the non-streaming behaviour)', () => {
  it('case 1: plain prose -> that prose is the answer, turn is done, no apology prepended', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return GOOD_PROSE;
    });
    const events = await runStreaming();
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const finalEvent = events.find((e) => e.type === 'final');
    expect(finalEvent?.message).toBe(GOOD_PROSE);
    expect(finalEvent?.salvage).toBeFalsy();

    const hit = warn.mock.calls.find((c) => String(c[0]).includes('forced-final produced no final action'));
    expect(hit).toBeTruthy();
    expect(hit![1]).toMatchObject({ path: 'prose_accepted' });
  });

  it('case 2: a proper {"action":"final","message":...} envelope is unchanged', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return JSON.stringify({ action: 'final', message: 'Here is what I found.' });
    });
    const events = await runStreaming();
    const finalEvent = events.find((e) => e.type === 'final');
    expect(finalEvent?.message).toBe('Here is what I found.');
    expect(warn.mock.calls.find((c) => String(c[0]).includes('forced-final'))).toBeUndefined();
  });

  it('case 3: a NON-final JSON envelope is rejected as prose and falls to salvage', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return JSON.stringify({ action: 'tool', tool: 'listLeads', args: { limit: 10 } });
    });
    const events = await runStreaming();
    const finalEvent = events.find((e) => e.type === 'final');
    expect(finalEvent?.salvage).toBe(true);
    expect(finalEvent?.message).not.toContain('"action"');
    expect(finalEvent?.message).not.toContain('listLeads');

    const hit = warn.mock.calls.find((c) => String(c[0]).includes('forced-final produced no final action'));
    expect(hit).toBeTruthy();
    expect(hit![1]).toMatchObject({ path: 'salvage' });
  });

  it('case 4: empty/whitespace response -> salvage path, exactly as before', async () => {
    let calls = 0;
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return '   \n  ';
    });
    const events = await runStreaming();
    const finalEvent = events.find((e) => e.type === 'final');
    expect(finalEvent?.salvage).toBe(true);
    const hit = warn.mock.calls.find((c) => String(c[0]).includes('forced-final produced no final action'));
    expect(hit).toBeTruthy();
    expect(hit![1]).toMatchObject({ path: 'salvage' });
  });

  it('case 5: a leading ```json fence with a dangling envelope fragment is stripped from what the user sees', async () => {
    let calls = 0;
    const raw = '```json\n{"action": "final", "mess\nActually, here is what I found: your best lead is Acme Corp, with strong intent signals from three site visits this week and a real budget behind it.';
    generateChat.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return toolCall();
      return raw;
    });
    const events = await runStreaming();
    const finalEvent = events.find((e) => e.type === 'final');
    expect(finalEvent?.message).not.toContain('```');
    expect(finalEvent?.message).not.toContain('"action"');
    expect(finalEvent?.message).not.toContain('{');
    expect(finalEvent?.message).toContain('Acme Corp');
  });
});

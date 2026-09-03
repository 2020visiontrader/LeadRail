// Cooperative, server-side stop (migration 083, task: "leadrail assistant
// audit — stop the run"). Before this, stopAll() in AgentConsole.tsx aborted
// only the BROWSER's own fetch — the server-side turn kept running
// regardless: spend continued, tools kept executing, approved sends still
// went out. This is the server half: the agent loop's between-steps check
// that honours a stop request (lib/agent/memory.ts's isStopRequested), at
// the SAME point the existing turnDeadline check already runs.
//
// These drive the REAL runAgent / runAgentStream loops (same harness as
// tests/agent-deadline-salvage.test.ts) — not a reimplementation — so this
// can only pass if the actual loop.ts stop branch runs and reuses
// buildSalvageMessage exactly like the deadline path does.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const runToolMock = vi.fn();
const isStopRequestedMock = vi.fn();

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
    listTags: { title: 'List Tags', sensitive: false },
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
vi.mock('@/lib/agent/compose', () => ({ composeAnswer: async (a: any) => a?.draft ?? '' }));
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
// Only isStopRequested is faked — every other export (estimateTokens,
// carryoverBlock, ...) stays the REAL implementation, so the loop's other
// uses of this module are unaffected.
vi.mock('@/lib/agent/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/memory')>();
  return { ...actual, isStopRequested: (...a: any[]) => isStopRequestedMock(...a) };
});

const TOOL_CALL = (tool: string, args: Record<string, any>) => JSON.stringify({ action: 'tool', tool, args });

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runToolMock.mockReset();
  isStopRequestedMock.mockReset();
});

describe('runAgent (JSON, non-streaming) — cooperative stop', () => {
  it('ends the turn between steps when a stop is requested, WITHOUT starting the next model call, and persists the gathered tool result', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi Markus', body: 'quick note' } });
    // Step 1: the model calls a tool.
    generateChat.mockResolvedValueOnce(TOOL_CALL('draftOutreach', { contactId: 'c1' }));
    // The stop check runs BEFORE step 2's model call. If it fires correctly,
    // generateChat is never called a second time — this mock existing at all
    // is the guard: a second call would consume it and this test would then
    // observe step-2 behaviour instead of the stop.
    generateChat.mockResolvedValueOnce(JSON.stringify({ action: 'final', message: 'should never be reached' }));
    // Not stopped before step 1 (matches "cleared at turn start"), stopped
    // before step 2.
    isStopRequestedMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' });

    expect(res.status).toBe('salvage');
    expect(res.message).toMatch(/stopped/i);
    expect(res.message).toContain('1 step');
    expect(res.message).toContain('draftOutreach');
    // The actual gathered work must be present, not discarded.
    expect(res.message).toContain('Draft outreach email');
    expect(res.message).toContain('hi Markus');
    // Never told the user this was a timeout or an outage.
    expect(res.message).not.toMatch(/ran out of time/i);
    expect(res.message).not.toContain('LeadRail AI is temporarily unavailable');
    // Only ONE model call happened — the stop was honoured before a second.
    expect(generateChat).toHaveBeenCalledTimes(1);
    // The transcript passed back for persistence carries the completed tool
    // call and its observation — see saveConversation's caller, which writes
    // res.transcript verbatim.
    const transcriptText = JSON.stringify(res.transcript);
    expect(transcriptText).toContain('draftOutreach');
    expect(transcriptText).toContain('hi Markus');
    // isStopRequested was scoped by conversationId and accountId, in that order.
    expect(isStopRequestedMock).toHaveBeenCalledWith('conv-1', 'acct-1');
  });

  it('reports the stop-specific empty message (not a generic error) when nothing had run yet', async () => {
    isStopRequestedMock.mockResolvedValueOnce(true);

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' });

    expect(res.status).toBe('error');
    expect(res.message).toMatch(/stopped/i);
    expect(res.message).not.toBe('LeadRail AI is temporarily unavailable. Please try again.');
    expect(generateChat).not.toHaveBeenCalled();
  });

  it('never checks (and can never be killed by) a stop request when the turn has no conversationId', async () => {
    // No conversationId at all — e.g. a delegate sub-run. isStopRequested
    // must not even be called, since there is nothing to scope it to.
    generateChat.mockResolvedValueOnce(JSON.stringify({ action: 'final', message: 'done' }));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'draft outreach' });

    expect(res.status).toBe('done');
    expect(isStopRequestedMock).not.toHaveBeenCalled();
  });
});

describe('runAgentStream (streaming) — cooperative stop (must match runAgentImpl)', () => {
  it('emits a terminal "final" event (salvage: true) carrying the gathered work, never a bare "error" event, when a stop is requested between steps', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi Markus', body: 'quick note' } });
    generateChat.mockResolvedValueOnce(TOOL_CALL('draftOutreach', { contactId: 'c1' }));
    generateChat.mockResolvedValueOnce(JSON.stringify({ action: 'final', message: 'should never be reached' }));
    isStopRequestedMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    const finalEvents = events.filter((e) => e.type === 'final');
    expect(finalEvents.length).toBe(1);
    expect(finalEvents[0].salvage).toBe(true);
    expect(finalEvents[0].message).toMatch(/stopped/i);
    expect(finalEvents[0].message).toContain('Draft outreach email');
    expect(finalEvents[0].message).toContain('hi Markus');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(generateChat).toHaveBeenCalledTimes(1);
    // The transcript on the terminal event — what the route persists — keeps
    // the completed tool call and its observation.
    const transcriptText = JSON.stringify(finalEvents[0].transcript);
    expect(transcriptText).toContain('draftOutreach');
    expect(transcriptText).toContain('hi Markus');
  });

  it('emits the stop-specific error event (not the generic outage message) when nothing was salvageable', async () => {
    isStopRequestedMock.mockResolvedValueOnce(true);

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.message).toMatch(/stopped/i);
    expect(errorEvent.message).not.toBe('LeadRail AI is temporarily unavailable. Please try again.');
    expect(events.some((e) => e.type === 'final')).toBe(false);
  });
});

// PIN CURRENT BEHAVIOUR: an ordinary turn where no stop was ever requested
// must be entirely unaffected by this feature existing.
describe('no stop requested — unchanged behaviour', () => {
  it('runAgent completes normally when isStopRequested is always false', async () => {
    isStopRequestedMock.mockResolvedValue(false);
    generateChat.mockResolvedValueOnce(JSON.stringify({ action: 'final', message: 'all done' }));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'hello', conversationId: 'conv-1' });

    expect(res.status).toBe('done');
    expect(res.message).toBe('all done');
  });
});

// Phase 2 — a turn that runs out of TIME with work still outstanding must not
// just apologize and ask the user to retry smaller: it converts the
// remainder into a durable plan (lib/plans/store.ts) and tells the user,
// honestly, that the rest is running in the background. See loop.ts's
// attemptEscalation and the ESCALATION_RESERVE_MS comment for the mechanism.
//
// These drive the REAL runAgent / runAgentStream loops (same harness as
// tests/agent-deadline-salvage.test.ts) so this can only pass if loop.ts's
// actual reserve check and DeadlineExceededError catch both call the real
// escalation path.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const runToolMock = vi.fn();
const createPlanMock = vi.fn();
const activePlanMock = vi.fn();

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
vi.mock('@/lib/plans/store', () => ({
  createPlan: (...a: any[]) => createPlanMock(...a),
  activePlanForConversation: (...a: any[]) => activePlanMock(...a),
  MAX_PLAN_STEPS: 40,
  MAX_STEP_OVER_ITEMS: 2000,
}));

const TOOL_CALL = (tool: string, args: Record<string, any>) => JSON.stringify({ action: 'tool', tool, args });

let now = 1_000_000;

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runToolMock.mockReset();
  createPlanMock.mockReset();
  activePlanMock.mockReset();
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  activePlanMock.mockResolvedValue(null);
  createPlanMock.mockImplementation(async (args: any) => ({
    id: 'plan-1',
    steps: args.steps.map((s: any, i: number) => (typeof s === 'string' ? { seq: i + 1, title: s } : { seq: i + 1, ...s })),
  }));
});

/** Advance the mocked clock past turnDeadline - ESCALATION_RESERVE_MS (but
 *  not past turnDeadline itself) on the FIRST model call, so the loop's
 *  SECOND iteration hits the graceful reserve check rather than throwing. */
function advanceIntoReserve() { now += 255_000; } // TURN_DEADLINE_MS(270s) - 15s: past the 20s reserve line, short of the hard deadline.

async function deadlineError() {
  const { deadlineExceededError } = await import('@/lib/ai/deadline');
  return deadlineExceededError('openrouter');
}

describe('escalation — the reserve check (graceful path)', () => {
  it('turns the remainder into a plan and tells the user work continues in the background', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi', body: 'note' } });
    let call = 0;
    generateChat.mockImplementation(async () => {
      call++;
      if (call === 1) { advanceIntoReserve(); return TOOL_CALL('draftOutreach', { contactId: 'c1' }); }
      // The escalation call.
      return JSON.stringify({ objective: 'Finish outreach', steps: ['Send the remaining emails'] });
    });

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'email everyone', conversationId: 'conv-1' });

    expect(createPlanMock).toHaveBeenCalledTimes(1);
    const created = createPlanMock.mock.calls[0][0];
    expect(created.accountId).toBe('acct-1');
    expect(created.conversationId).toBe('conv-1');
    expect(created.steps).toEqual(['Send the remaining emails']);

    expect(res.status).toBe('salvage');
    expect(res.message).toMatch(/background/i);
    expect(res.message).not.toMatch(/Try breaking this into a smaller request/i);
  });

  it('a remainder that iterates a list becomes ONE batch step with `over`, not N steps', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: {} });
    let call = 0;
    generateChat.mockImplementation(async () => {
      call++;
      if (call === 1) { advanceIntoReserve(); return TOOL_CALL('listTags', {}); }
      return JSON.stringify({
        objective: 'Draft outreach for every remaining lead',
        steps: [{ title: 'Draft outreach for each lead', over: ['lead-1', 'lead-2', 'lead-3'] }],
      });
    });

    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'email everyone', conversationId: 'conv-1' });

    expect(createPlanMock).toHaveBeenCalledTimes(1);
    const created = createPlanMock.mock.calls[0][0];
    // ONE step carrying `over`, not three separate steps.
    expect(created.steps).toHaveLength(1);
    expect(created.steps[0]).toMatchObject({ title: 'Draft outreach for each lead', over: ['lead-1', 'lead-2', 'lead-3'] });
  });

  it('THE GUARD: an active plan already on the conversation stops a second one from being created', async () => {
    activePlanMock.mockResolvedValue({ id: 'existing-plan', steps: [] });
    runToolMock.mockResolvedValue({ ok: true, result: {} });
    let call = 0;
    generateChat.mockImplementation(async () => {
      call++;
      if (call === 1) { advanceIntoReserve(); return TOOL_CALL('listTags', {}); }
      // Should never be reached — the guard short-circuits before any model call.
      return JSON.stringify({ objective: 'x', steps: ['y'] });
    });

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'email everyone', conversationId: 'conv-1' });

    expect(createPlanMock).not.toHaveBeenCalled();
    expect(activePlanMock).toHaveBeenCalledWith('acct-1', 'conv-1');
    expect(res.status).toBe('salvage');
    expect(res.message).toMatch(/already running/i);
  });

  it('no conversationId — no escalation, exactly today\'s reserve-free behaviour', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi', body: 'note' } });
    let call = 0;
    generateChat.mockImplementation(async () => {
      call++;
      if (call === 1) { advanceIntoReserve(); return TOOL_CALL('draftOutreach', { contactId: 'c1' }); }
      // If escalation were attempted anyway this would be consumed as the
      // escalation call; it must never be reached without a conversationId.
      return JSON.stringify({ action: 'final', message: 'should not get here' });
    });

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'email everyone' });

    expect(activePlanMock).not.toHaveBeenCalled();
    expect(createPlanMock).not.toHaveBeenCalled();
    // Falls through to the break -> forced-final path (today's behaviour):
    // the second generateChat call above is now the FORCED-FINAL call, which
    // returned a final envelope, so the turn simply finishes normally.
    expect(res.status).toBe('done');
  });

  it('escalation call returning garbage falls back to exactly today\'s salvage behaviour', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi', body: 'note' } });
    let call = 0;
    generateChat.mockImplementation(async () => {
      call++;
      if (call === 1) { advanceIntoReserve(); return TOOL_CALL('draftOutreach', { contactId: 'c1' }); }
      if (call === 2) return 'not json at all';       // the escalation call — unusable
      return 'still not usable';                        // the forced-final fallback call
    });

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'email everyone', conversationId: 'conv-1' });

    expect(createPlanMock).not.toHaveBeenCalled();
    // Falls all the way through to the ordinary (non-deadline) salvage the
    // forced-final path already produced before escalation existed.
    expect(res.message).not.toMatch(/background/i);
  });
});

describe('escalation — the thrown DeadlineExceededError path', () => {
  it('also escalates: a single slow call that blows the whole budget still converts the remainder to a plan', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi Markus', body: 'quick note' } });
    generateChat.mockResolvedValueOnce(TOOL_CALL('draftOutreach', { contactId: 'c1' }));
    generateChat.mockRejectedValueOnce(await deadlineError());
    generateChat.mockResolvedValueOnce(JSON.stringify({ objective: 'Finish outreach', steps: ['Send the rest'] }));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' });

    expect(createPlanMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('salvage');
    expect(res.message).toMatch(/background/i);
  });

  it('guard also applies on the thrown path: an active plan blocks escalation here too', async () => {
    activePlanMock.mockResolvedValue({ id: 'existing-plan', steps: [] });
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi', body: 'note' } });
    generateChat.mockResolvedValueOnce(TOOL_CALL('draftOutreach', { contactId: 'c1' }));
    generateChat.mockRejectedValueOnce(await deadlineError());

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' });

    expect(createPlanMock).not.toHaveBeenCalled();
    expect(res.message).toMatch(/already running/i);
  });

  it('falls back to the existing deadline-salvage message when the escalation call fails', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi Markus', body: 'quick note' } });
    generateChat.mockResolvedValueOnce(TOOL_CALL('draftOutreach', { contactId: 'c1' }));
    generateChat.mockRejectedValueOnce(await deadlineError());
    generateChat.mockRejectedValueOnce(new Error('escalation model unavailable'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' });

    expect(createPlanMock).not.toHaveBeenCalled();
    expect(res.status).toBe('salvage');
    expect(res.message).toMatch(/ran out of time/i);
    expect(res.message).toMatch(/Try breaking this into a smaller request/i);
  });
});

describe('escalation — runAgentStream matches runAgent exactly', () => {
  it('escalates identically on the reserve path', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi', body: 'note' } });
    let call = 0;
    generateChat.mockImplementation(async () => {
      call++;
      if (call === 1) { advanceIntoReserve(); return TOOL_CALL('draftOutreach', { contactId: 'c1' }); }
      return JSON.stringify({ objective: 'Finish outreach', steps: ['Send the remaining emails'] });
    });

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream({ accountId: 'acct-1', message: 'email everyone', conversationId: 'conv-1' }, (e) => events.push(e));

    expect(createPlanMock).toHaveBeenCalledTimes(1);
    const finalEvents = events.filter((e) => e.type === 'final');
    expect(finalEvents.length).toBe(1);
    expect(finalEvents[0].salvage).toBe(true);
    expect(finalEvents[0].message).toMatch(/background/i);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('escalates identically on the thrown-deadline path', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi Markus', body: 'quick note' } });
    generateChat.mockResolvedValueOnce(TOOL_CALL('draftOutreach', { contactId: 'c1' }));
    generateChat.mockRejectedValueOnce(await deadlineError());
    generateChat.mockResolvedValueOnce(JSON.stringify({ objective: 'Finish outreach', steps: ['Send the rest'] }));

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream({ accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' }, (e) => events.push(e));

    expect(createPlanMock).toHaveBeenCalledTimes(1);
    const finalEvents = events.filter((e) => e.type === 'final');
    expect(finalEvents.length).toBe(1);
    expect(finalEvents[0].salvage).toBe(true);
    expect(finalEvents[0].message).toMatch(/background/i);
  });
});

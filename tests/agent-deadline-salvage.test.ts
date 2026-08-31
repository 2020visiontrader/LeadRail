// Fix 1 (see the task spec this shipped under): a turn that dies to
// TURN_DEADLINE_MS — DeadlineExceededError thrown out of generateChat mid
// step-loop — must not be reported as a generic outage, and must not discard
// the tool results the turn already gathered.
//
// PRODUCTION EVIDENCE: a real turn died after 300,005ms with toolCalls
// ["draftOutreach","draftOutreach"], stepCount 2, and the user's 48
// successfully-drafted outreach emails (two prior batches) were all
// discarded behind "LeadRail AI is temporarily unavailable. Please try
// again." — a message that is actively wrong for a deadline: retrying hits
// the exact same wall.
//
// These drive the REAL runAgent / runAgentStream loops (same harness as
// tests/agent-salvage.test.ts and tests/agent-json-retry.test.ts) — not a
// reimplementation — so this can only pass if the actual loop.ts deadline
// branch runs and actually reuses buildSalvageMessage.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const runToolMock = vi.fn();

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

const TOOL_CALL = (tool: string, args: Record<string, any>) => JSON.stringify({ action: 'tool', tool, args });

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runToolMock.mockReset();
});

/** Import the real DeadlineExceededError so a mocked rejection is
 *  `instanceof` it, exactly like the real generateChat->router->openrouter
 *  path throws it. Using a plain Error here would NOT catch the bug this
 *  test exists to pin (loop.ts detecting it with `instanceof`, not a string
 *  match). */
async function deadlineError() {
  const { deadlineExceededError } = await import('@/lib/ai/deadline');
  return deadlineExceededError('openrouter');
}

describe('runAgent (JSON, non-streaming) — deadline salvage', () => {
  it('returns status "salvage" with the gathered tool results and an honest, non-"try again" message when the model call throws a deadline error mid-loop', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi Markus', body: 'quick note' } });
    generateChat.mockResolvedValueOnce(TOOL_CALL('draftOutreach', { contactId: 'c1' }));
    generateChat.mockRejectedValueOnce(await deadlineError());

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' });

    expect(res.status).toBe('salvage');
    // Honest about WHY: ran out of time, not a generic outage.
    expect(res.message).toMatch(/ran out of time/i);
    // Says roughly how far it got.
    expect(res.message).toContain('1 step');
    expect(res.message).toContain('draftOutreach');
    // Must NOT tell the user to just try again, as if transient.
    expect(res.message).not.toContain('LeadRail AI is temporarily unavailable');
    expect(res.message).not.toMatch(/^Please try again/);
    // The actual gathered work must be present, not discarded.
    expect(res.message).toContain('Draft outreach email');
    expect(res.message).toContain('hi Markus');
  });

  it('falls back to a deadline-specific (not generic) message when nothing was salvageable', async () => {
    generateChat.mockRejectedValueOnce(await deadlineError());

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' });

    expect(res.status).toBe('error');
    expect(res.message).toMatch(/ran out of time/i);
    expect(res.message).not.toBe('LeadRail AI is temporarily unavailable. Please try again.');
  });
});

describe('runAgentStream (streaming) — deadline salvage (must match runAgentImpl)', () => {
  it('emits a terminal "final" event (salvage: true) carrying the gathered work, never a bare "error" event, on a deadline error mid-loop', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi Markus', body: 'quick note' } });
    generateChat.mockResolvedValueOnce(TOOL_CALL('draftOutreach', { contactId: 'c1' }));
    generateChat.mockRejectedValueOnce(await deadlineError());

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    const finalEvents = events.filter((e) => e.type === 'final');
    expect(finalEvents.length).toBe(1);
    expect(finalEvents[0].salvage).toBe(true);
    expect(finalEvents[0].message).toMatch(/ran out of time/i);
    expect(finalEvents[0].message).toContain('Draft outreach email');
    expect(finalEvents[0].message).toContain('hi Markus');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('emits the deadline-specific error event (not the generic outage message) when nothing was salvageable', async () => {
    generateChat.mockRejectedValueOnce(await deadlineError());

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.message).toMatch(/ran out of time/i);
    expect(errorEvent.message).not.toBe('LeadRail AI is temporarily unavailable. Please try again.');
    expect(events.some((e) => e.type === 'final')).toBe(false);
  });
});

// PIN CURRENT BEHAVIOUR: a NON-deadline model failure (ladder exhausted, a
// plain provider error, etc.) mid-loop must still produce exactly today's
// generic message — this is the thing the deadline branch must NOT change.
describe('non-deadline model failure mid-loop — unchanged behaviour', () => {
  it('runAgent still returns the generic outage message for an ordinary error', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi Markus', body: 'quick note' } });
    generateChat.mockResolvedValueOnce(TOOL_CALL('draftOutreach', { contactId: 'c1' }));
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' });

    expect(res.status).toBe('error');
    expect(res.message).toBe('LeadRail AI is temporarily unavailable. Please try again.');
  });

  it('runAgentStream still emits the generic outage error event for an ordinary error', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi Markus', body: 'quick note' } });
    generateChat.mockResolvedValueOnce(TOOL_CALL('draftOutreach', { contactId: 'c1' }));
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.message).toBe('LeadRail AI is temporarily unavailable. Please try again.');
    expect(events.some((e) => e.type === 'final')).toBe(false);
  });
});

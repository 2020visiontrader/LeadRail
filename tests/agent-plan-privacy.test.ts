// `plan` is the model's private reasoning channel. Two things have to hold, and
// they pull in opposite directions:
//
//   1. It must PERSIST — the whole envelope goes back into the transcript, so a
//      later step in the same turn can see what the earlier one worked out.
//   2. It must never be RENDERED to the user — not as a thinking line, not as
//      an observation, not in the answer.
//
// The streaming loop is what real chat turns run (CLAUDE.md), so that is where
// the rendering half is pinned.
//
// THE EXCLUSION THIS FILE USED TO NAME IS CLOSED. It read: "the `final` SSE
// event carries `transcript`, and the transcript is exactly where requirement 1
// puts the raw envelope, so the plan text DOES cross the wire … 'never leaves
// the server' is not true and this file does not pretend otherwise." That was
// accurate, and it meant the system prompt's promise to the model ("shown to NO
// ONE") was stronger than what the code delivered.
//
// It no longer crosses. Every route that hands a transcript to a browser now
// passes it through stripPrivateReasoning first — all FOUR of them, including
// the reload and rerun paths the original packet did not name. See
// lib/agent/transcript-privacy.ts and tests/agent-transcript-privacy.test.ts,
// which owns that half.
//
// This file keeps the RENDERING half, and the `transcript` field is still
// excluded from its scan below — but now because that field is the SERVER's
// copy (requirement 1), not because of an exposure. The test directly under
// this comment block asserts the plan is STILL in it, which is what stops the
// privacy assertions from going vacuous.

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
  ApprovalExecutionError: class extends Error {},
}));
vi.mock('@/lib/capabilities/delegation', () => ({
  beginDelegationScope: vi.fn(), endDelegationScope: vi.fn(), setDelegationContext: vi.fn(),
}));
vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: async () => ({ skillIds: [] }) }));
vi.mock('@/lib/credits', () => ({ markParseOutcome: vi.fn(), recordAiUsage: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));

// Deliberately distinctive so a substring scan cannot false-negative.
const PLAN = 'PRIVATEPLANMARKER the enrichment budget is unknown and I have not checked it yet';

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runTool.mockReset();
  runTool.mockImplementation(async () => ({ ok: true, result: { rows: ['lead-a'] } }));
});

async function stream(...responses: string[]) {
  for (const r of responses) generateChat.mockResolvedValueOnce(r);
  const { runAgentStream } = await import('@/lib/agent/loop');
  const events: any[] = [];
  await runAgentStream({ accountId: 'acct-1', message: 'who are my leads?', conversationId: 'conv-1' }, (e) => events.push(e));
  return events;
}

/** Every event field a human reads, with the server-side `transcript` removed
 *  (see the header): the loop EMITS the full envelope there on purpose, and the
 *  route strips it at the wire. This scan is about the other fields. */
const renderedText = (events: any[]) =>
  JSON.stringify(events.map(({ transcript, ...rest }: any) => rest));

describe('plan never reaches anything the user is shown (streaming loop)', () => {
  it('a tool step emits the narration and never the plan', async () => {
    const events = await stream(
      JSON.stringify({ plan: PLAN, narration: 'Pulling your leads…', action: 'tool', tool: 'listLeads', args: {} }),
      JSON.stringify({ plan: PLAN, narration: 'Writing it up…', action: 'final', message: 'You have one lead.' }),
    );

    const thoughts = events.filter((e) => e.type === 'thought').map((e) => e.text);
    expect(thoughts).toContain('Pulling your leads…');
    expect(renderedText(events)).not.toContain('PRIVATEPLANMARKER');
    expect(events.find((e) => e.type === 'final').message).toBe('You have one lead.');
  });

  it('the plan is still in the transcript, so a later step in the turn can see it', async () => {
    // The other half of the contract: privacy must not have been bought by
    // dropping the field. If this ever goes red because `plan` was stripped on
    // the way into the transcript, the privacy test above became vacuous.
    const events = await stream(
      JSON.stringify({ plan: PLAN, narration: 'Pulling your leads…', action: 'tool', tool: 'listLeads', args: {} }),
      JSON.stringify({ narration: 'Writing it up…', action: 'final', message: 'You have one lead.' }),
    );
    const transcript = events.find((e) => e.type === 'final').transcript;
    expect(JSON.stringify(transcript)).toContain('PRIVATEPLANMARKER');
  });

  it('a plan on the FINAL envelope is not leaked into the answer either', async () => {
    const events = await stream(
      JSON.stringify({ plan: PLAN, narration: 'Answering…', action: 'final', message: 'Nothing to report.' }),
    );
    expect(renderedText(events)).not.toContain('PRIVATEPLANMARKER');
    expect(events.find((e) => e.type === 'final').message).toBe('Nothing to report.');
  });
});

describe('backward compatibility: the old thought-only envelope still works', () => {
  it('falls back to "thought" as the narration when "narration" is absent', async () => {
    const events = await stream(
      JSON.stringify({ thought: 'Checking your active campaigns…', action: 'tool', tool: 'listLeads', args: {} }),
      JSON.stringify({ thought: 'Done.', action: 'final', message: 'One lead.' }),
    );
    expect(events.filter((e) => e.type === 'thought').map((e) => e.text)).toContain('Checking your active campaigns…');
  });

  it('narration wins over thought when both are present', async () => {
    const events = await stream(
      JSON.stringify({ thought: 'RAWTHOUGHT', narration: 'Pulling your leads…', action: 'tool', tool: 'listLeads', args: {} }),
      JSON.stringify({ action: 'final', message: 'One lead.' }),
    );
    const thoughts = events.filter((e) => e.type === 'thought').map((e) => e.text);
    expect(thoughts).toContain('Pulling your leads…');
    expect(thoughts).not.toContain('RAWTHOUGHT');
  });

  it('an empty narration falls back rather than emitting a blank thinking line', async () => {
    const events = await stream(
      JSON.stringify({ thought: 'Checking things…', narration: '   ', action: 'tool', tool: 'listLeads', args: {} }),
      JSON.stringify({ action: 'final', message: 'One lead.' }),
    );
    expect(events.filter((e) => e.type === 'thought').map((e) => e.text)).toContain('Checking things…');
  });

  it('the non-streaming loop persists the same narration onto the step', async () => {
    generateChat
      .mockResolvedValueOnce(JSON.stringify({ plan: PLAN, thought: 'RAWTHOUGHT', narration: 'Pulling your leads…', action: 'tool', tool: 'listLeads', args: {} }))
      .mockResolvedValueOnce(JSON.stringify({ action: 'final', message: 'One lead.' }));
    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'who are my leads?', conversationId: 'conv-1' });
    const step = res.steps.find((s) => s.tool === 'listLeads');
    expect(step!.thought).toBe('Pulling your leads…');
    // AgentStep is returned to the browser verbatim by app/api/agent/route.ts,
    // so it must not grow a `plan` field.
    expect(JSON.stringify(res.steps)).not.toContain('PRIVATEPLANMARKER');
  });
});

describe('the system prompt asks for the three-field envelope', () => {
  it('documents plan first, and pins the ordering', async () => {
    let system = '';
    generateChat.mockImplementationOnce(async (a: any) => { system = a.system; return JSON.stringify({ action: 'final', message: 'hi' }); });
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'hello', conversationId: 'conv-1' });

    // "plan" precedes "action" in every documented shape — the ordering is the
    // point (reasoning that conditions the decision, not one that narrates it).
    for (const line of system.split('\n').filter((l) => l.trim().startsWith('{"'))) {
      expect(line.indexOf('"plan"')).toBeGreaterThanOrEqual(0);
      expect(line.indexOf('"plan"')).toBeLessThan(line.indexOf('"action"'));
    }
    expect(system).toContain('action":"tools"');
    expect(system).toContain('shown to NO ONE');
    // The verification rule with teeth.
    expect(system).toMatch(/must name the observation in THIS turn/);
  });
});

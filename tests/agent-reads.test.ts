// action:"tools" — several DIFFERENT read-only tools in ONE step.
//
// The property that actually matters here is the SAFETY one: a `reads` list
// containing anything that is not `gate: 'read'` must reject the WHOLE step and
// run nothing. That is what keeps this path away from the approval card — no
// spend, no external send, no partial execution where the reads happened and
// the write was "about to". Everything else in this file is there so the
// feature is usable; that one is there so it is safe.
//
// CLAUDE.md: the two loops must stay identical, so every loop-level assertion
// below is made against runAgent AND runAgentStream with the same fixture.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseReads, runReads, readsSummary, MAX_READS } from '@/lib/agent/reads';

// ---------------------------------------------------------------------------
// Pure parser — no database, no loop. Same reasoning as lib/agent/batch.ts's
// tests: the bounds are what matter and they are testable directly.
// ---------------------------------------------------------------------------

const GATES: Record<string, string> = {
  listVentures: 'read',
  listLeads: 'read',
  getBudget: 'read',
  listTags: 'read',
  listCampaigns: 'read',
  saveDraft: 'internal_write',
  enrichLead: 'spend',
  sendEmail: 'external_send',
};
const resolver = {
  known: (t: string) => t in GATES || t === 'mcpThing',
  gateOf: (t: string) => GATES[t], // 'mcpThing' -> undefined, like an external-MCP tool
};

describe('parseReads', () => {
  it('is inert unless the envelope explicitly says action:"tools"', () => {
    expect(parseReads({ action: 'tool', tool: 'listLeads', args: {} }, resolver)).toEqual({ kind: 'none' });
    expect(parseReads({ action: 'final', message: 'hi' }, resolver)).toEqual({ kind: 'none' });
    // Even a stray `reads` key on an ordinary envelope must not take this path.
    expect(parseReads({ action: 'tool', tool: 'listLeads', reads: [{ tool: 'sendEmail' }] }, resolver)).toEqual({ kind: 'none' });
  });

  it('accepts several different read tools', () => {
    const r = parseReads({ action: 'tools', reads: [{ tool: 'listVentures', args: {} }, { tool: 'listLeads', args: { limit: 5 } }] }, resolver);
    expect(r.kind).toBe('reads');
    if (r.kind === 'reads') expect(r.reads).toEqual([{ tool: 'listVentures', args: {} }, { tool: 'listLeads', args: { limit: 5 } }]);
  });

  it('defaults a missing args object rather than rejecting the step', () => {
    const r = parseReads({ action: 'tools', reads: [{ tool: 'listVentures' }, { tool: 'listLeads' }] }, resolver);
    expect(r.kind).toBe('reads');
    if (r.kind === 'reads') expect(r.reads.map((x) => x.args)).toEqual([{}, {}]);
  });

  // THE SAFETY PROPERTY.
  it.each([
    ['an internal write', 'saveDraft'],
    ['a spend tool', 'enrichLead'],
    ['an external send', 'sendEmail'],
    ['a tool with no first-party capability at all', 'mcpThing'],
  ])('rejects the WHOLE step when it contains %s', (_label, tool) => {
    const r = parseReads({ action: 'tools', reads: [{ tool: 'listVentures', args: {} }, { tool, args: {} }] }, resolver);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.reason).toContain(tool);
  });

  it('rejects a non-read even when it is the only entry', () => {
    expect(parseReads({ action: 'tools', reads: [{ tool: 'sendEmail', args: {} }] }, resolver).kind).toBe('invalid');
  });

  it('reports an unknown tool name separately, so the loop can use its own correction', () => {
    const r = parseReads({ action: 'tools', reads: [{ tool: 'listLeads' }, { tool: 'getDeckSummary' }] }, resolver);
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.tool).toBe('getDeckSummary');
  });

  it('refuses a missing, empty, or non-array "reads"', () => {
    expect(parseReads({ action: 'tools' }, resolver).kind).toBe('invalid');
    expect(parseReads({ action: 'tools', reads: [] }, resolver).kind).toBe('invalid');
    expect(parseReads({ action: 'tools', reads: 'both of them' }, resolver).kind).toBe('invalid');
    expect(parseReads({ action: 'tools', reads: [{ tool: 'listLeads' }, 'oops'] }, resolver).kind).toBe('invalid');
    expect(parseReads({ action: 'tools', reads: [{ args: {} }] }, resolver).kind).toBe('invalid');
  });

  it('caps the number of tools in one step', () => {
    const names = ['listVentures', 'listLeads', 'getBudget', 'listTags', 'listCampaigns'];
    expect(names.length).toBeGreaterThan(MAX_READS);
    const r = parseReads({ action: 'tools', reads: names.map((tool) => ({ tool })) }, resolver);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.reason).toContain(String(MAX_READS));
    expect(parseReads({ action: 'tools', reads: names.slice(0, MAX_READS).map((tool) => ({ tool })) }, resolver).kind).toBe('reads');
  });

  it('refuses the same tool twice — that is the "calls" shape, and would route a batch around MAX_BATCH', () => {
    const r = parseReads({ action: 'tools', reads: [{ tool: 'listLeads', args: { a: 1 } }, { tool: 'listLeads', args: { a: 2 } }] }, resolver);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.reason).toContain('calls');
  });

  it('refuses a "calls" array smuggled into a reads entry', () => {
    expect(parseReads({ action: 'tools', reads: [{ tool: 'listLeads', calls: [{ a: 1 }] }] }, resolver).kind).toBe('invalid');
  });
});

describe('runReads', () => {
  it('runs concurrently and reports in INPUT order', async () => {
    let live = 0;
    let peak = 0;
    const results = await runReads(
      [{ tool: 'a', args: { ms: 25 } }, { tool: 'b', args: { ms: 0 } }, { tool: 'c', args: { ms: 10 } }],
      async (tool, args) => {
        live++; peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, args.ms));
        live--;
        return { ok: true, result: tool };
      },
    );
    expect(results.map((r) => r.result)).toEqual(['a', 'b', 'c']);
    expect(peak).toBe(3); // actually concurrent, not accidentally serial
  });

  it('one failure never cancels the others, and a throw is caught', async () => {
    const results = await runReads(
      [{ tool: 'a', args: {} }, { tool: 'b', args: {} }, { tool: 'c', args: {} }],
      async (tool) => {
        if (tool === 'b') throw new Error('boom');
        if (tool === 'c') return { ok: false, error: 'nope' };
        return { ok: true, result: 'fine' };
      },
    );
    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(results[1].error).toContain('boom');
    expect(readsSummary(results)).toBe('3 reads — a: ok, b: FAILED, c: FAILED.');
  });
});

// ---------------------------------------------------------------------------
// The real loops. Same mock frame as tests/agent-skill-slugs.test.ts.
// ---------------------------------------------------------------------------

const generateChat = vi.fn();
const runTool = vi.fn();
const createApproval = vi.fn();

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: {
    listVentures: { title: 'List ventures', sensitive: false },
    listLeads: { title: 'List leads', sensitive: false },
    sendEmail: { title: 'Send email', sensitive: true },
  },
  runTool: (...a: any[]) => runTool(...a),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  capabilityFor: (n: string) => (GATES[n] ? { gate: GATES[n] } : undefined),
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
  createApproval: (...a: any[]) => createApproval(...a),
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

const FINAL = JSON.stringify({ plan: 'Both lookups came back.', narration: 'Writing it up…', action: 'final', message: 'All done.' });

const TWO_READS = JSON.stringify({
  plan: 'I need the venture list and the lead list before I can answer, and neither depends on the other.',
  narration: 'Looking up two things at once…',
  action: 'tools',
  reads: [{ tool: 'listVentures', args: {} }, { tool: 'listLeads', args: { limit: 5 } }],
});

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runTool.mockReset();
  createApproval.mockReset();
  runTool.mockImplementation(async (name: string) => ({ ok: true, result: { from: name, rows: [`${name}-row`] } }));
});

const run = async () => {
  const { runAgent } = await import('@/lib/agent/loop');
  return runAgent({ accountId: 'acct-1', message: 'what do I have?', conversationId: 'conv-1' });
};
const runStream = async () => {
  const { runAgentStream } = await import('@/lib/agent/loop');
  const events: any[] = [];
  await runAgentStream({ accountId: 'acct-1', message: 'what do I have?', conversationId: 'conv-1' }, (e) => events.push(e));
  return events;
};

describe('a reads step with two read tools runs both (non-streaming)', () => {
  it('runs both and folds one observation that names both tools', async () => {
    generateChat.mockResolvedValueOnce(TWO_READS).mockResolvedValueOnce(FINAL);
    const res = await run();

    expect(res.status).toBe('done');
    expect(runTool.mock.calls.map((c) => c[0])).toEqual(['listVentures', 'listLeads']);
    expect(runTool.mock.calls[1][2]).toEqual({ limit: 5 });

    const step = res.steps.find((s) => s.tool === 'listVentures + listLeads');
    expect(step).toBeTruthy();
    // The LABEL, not just the payload: a result mentioning its own tool name is
    // not attribution. Assert the fold's own per-tool prefix.
    expect(step!.observation).toContain('listVentures: ok');
    expect(step!.observation).toContain('listLeads: ok');
    expect(step!.observation).toContain('[1] listVentures — ok');
    expect(step!.observation).toContain('[2] listLeads — ok');
    expect(step!.observation).toContain('listVentures-row');
    expect(step!.observation).toContain('listLeads-row');
    // The narration, not the plan, is what gets persisted onto the step.
    expect(step!.thought).toBe('Looking up two things at once…');

    const obsMsg = res.transcript.find((m) => m.content.startsWith('OBSERVATION: 2 reads'));
    expect(obsMsg?.content).toContain('listVentures: ok');
    expect(obsMsg?.content).toContain('listLeads: ok');
  });
});

describe('a reads step with two read tools runs both (streaming)', () => {
  it('emits one tool event and one observation naming both tools', async () => {
    generateChat.mockResolvedValueOnce(TWO_READS).mockResolvedValueOnce(FINAL);
    const events = await runStream();

    expect(runTool.mock.calls.map((c) => c[0])).toEqual(['listVentures', 'listLeads']);

    const toolEvents = events.filter((e) => e.type === 'tool');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].title).toContain('listVentures + listLeads');
    expect(toolEvents[0].args).toEqual({ reads: [{ tool: 'listVentures', args: {} }, { tool: 'listLeads', args: { limit: 5 } }] });

    const obs = events.filter((e) => e.type === 'observation');
    expect(obs).toHaveLength(1);
    expect(obs[0].ok).toBe(true);
    expect(obs[0].text).toContain('[1] listVentures — ok');
    expect(obs[0].text).toContain('[2] listLeads — ok');
    expect(events.find((e) => e.type === 'final')?.message).toBe('All done.');
  });

  it('marks the observation not-ok when one of the reads failed', async () => {
    runTool.mockImplementation(async (name: string) =>
      name === 'listLeads' ? { ok: false, error: 'lead store unavailable' } : { ok: true, result: { from: name } });
    generateChat.mockResolvedValueOnce(TWO_READS).mockResolvedValueOnce(FINAL);
    const events = await runStream();
    const obs = events.find((e) => e.type === 'observation');
    expect(obs.ok).toBe(false);
    expect(obs.text).toContain('listLeads: FAILED');
    expect(obs.text).toContain('lead store unavailable');
    // The read that worked is still reported — a partial result the model can
    // attribute beats discarding the half that succeeded.
    expect(obs.text).toContain('listVentures: ok');
  });
});

// ---------------------------------------------------------------------------
// THE SAFETY PROPERTY, through both real loops.
// ---------------------------------------------------------------------------

const READS_WITH_SEND = JSON.stringify({
  plan: 'I will look up the leads and mail them in one go.',
  narration: 'Checking and sending…',
  action: 'tools',
  reads: [{ tool: 'listLeads', args: {} }, { tool: 'sendEmail', args: { to: 'someone@example.com' } }],
});

describe('a reads step naming a non-read tool is rejected and NOTHING executes', () => {
  it('non-streaming: no tool runs, no approval is raised, and the model is told why', async () => {
    generateChat.mockResolvedValueOnce(READS_WITH_SEND).mockResolvedValueOnce(FINAL);
    const res = await run();

    // The whole point: not "the read ran and the send was blocked" — NOTHING ran.
    expect(runTool).not.toHaveBeenCalled();
    expect(createApproval).not.toHaveBeenCalled();
    expect(res.status).toBe('done');

    const correction = res.transcript.find((m) => m.content.includes('NOTHING ran'));
    expect(correction).toBeTruthy();
    expect(correction!.content).toContain('sendEmail');
    expect(correction!.content).toContain('action:"tool"');
  });

  it('streaming: identical — no tool runs, no approval, no needs_approval event', async () => {
    generateChat.mockResolvedValueOnce(READS_WITH_SEND).mockResolvedValueOnce(FINAL);
    const events = await runStream();

    expect(runTool).not.toHaveBeenCalled();
    expect(createApproval).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'needs_approval')).toBe(false);
    expect(events.some((e) => e.type === 'tool')).toBe(false);

    const obs = events.find((e) => e.type === 'observation');
    expect(obs.ok).toBe(false);
    expect(obs.text).toContain('NOTHING ran');
    expect(obs.text).toContain('sendEmail');
  });
});

describe('an unknown tool name inside reads', () => {
  const READS_WITH_GHOST = JSON.stringify({
    plan: 'Guessing at a getter.',
    narration: 'Looking things up…',
    action: 'tools',
    reads: [{ tool: 'listLeads', args: {} }, { tool: 'getDeckSummary', args: {} }],
  });

  it('runs nothing and reuses the existing unknown-tool correction (both loops)', async () => {
    generateChat.mockResolvedValueOnce(READS_WITH_GHOST).mockResolvedValueOnce(FINAL);
    const res = await run();
    expect(runTool).not.toHaveBeenCalled();
    const correction = res.transcript.find((m) => m.content.includes('there is no tool called'));
    expect(correction!.content).toContain('getDeckSummary');

    runTool.mockClear();
    generateChat.mockReset();
    generateChat.mockResolvedValueOnce(READS_WITH_GHOST).mockResolvedValueOnce(FINAL);
    const events = await runStream();
    expect(runTool).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'observation').text).toContain('Unknown tool "getDeckSummary"');
  });
});

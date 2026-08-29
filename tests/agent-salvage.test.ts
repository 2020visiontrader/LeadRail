// FIX 1 (see the task spec this shipped under): a failed forced-final call
// must not throw away tool results that already succeeded this turn.
//
// Production evidence: a turn logged toolCalls: ["listTags","listLeads"],
// stepCount: 2, durationMs: 207477 — both tools succeeded, then the
// forced-final call failed, and the turn returned the bare generic apology
// with everything gathered thrown away.
//
// These drive the REAL runAgent / runAgentStream loops (not a
// reimplementation) — same harness as tests/agent-json-retry.test.ts — so
// this can only pass if the actual loop.ts salvage path runs.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const runToolMock = vi.fn();
const warn = vi.fn();

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
  log: { info: vi.fn(), warn: (...a: any[]) => warn(...a), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: {
    listTags: { title: 'List Tags', sensitive: false },
    listLeads: { title: 'List Leads', sensitive: false },
    draftOutreach: { title: 'Draft outreach email', sensitive: false },
    getPersona: { title: 'Get sender persona', sensitive: false },
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
const DUP_TOOL_CALL = (tool: string, n: number) => TOOL_CALL(tool, { call: n });
const BATCH_CALL = (tool: string, calls: Record<string, any>[]) => JSON.stringify({ action: 'tool', tool, calls });

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runToolMock.mockReset();
  warn.mockReset();
});

/** Drives the loop into forced-final the FAST way: call the same tool
 *  repeatedly so the duplicate-call guard (toolCalls[tool] >= 2, then two
 *  nudges) breaks out of the ReAct loop on its own — far cheaper in test time
 *  than exhausting MAX_STEPS or TURN_DEADLINE_MS, and it's a real path
 *  through the real loop, not a shortcut around it. */
function queueUpToForcedFinal(tool: string) {
  generateChat.mockResolvedValueOnce(DUP_TOOL_CALL(tool, 1));
  generateChat.mockResolvedValueOnce(DUP_TOOL_CALL(tool, 2));
  generateChat.mockResolvedValueOnce(DUP_TOOL_CALL(tool, 3)); // toolCalls[tool] now >= 2 -> nudge 1
  generateChat.mockResolvedValueOnce(DUP_TOOL_CALL(tool, 4)); // nudge 2 -> break to forced-final
}

describe('runAgent (JSON, non-streaming) — salvage after forced-final fails', () => {
  it('returns the gathered tool results, not the bare apology, when tools succeeded and forced-final throws', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { tags: ['vip', 'cold'] } });
    queueUpToForcedFinal('listTags');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'what tags do we have?', conversationId: 'conv-1' });

    expect(res.status).toBe('salvage');
    expect(res.message).not.toContain('I gathered the details but had trouble summarizing');
    expect(res.message).toContain('List Tags');
    expect(res.message).toContain('vip');
  });

  it('falls back to the plain apology when there is nothing to salvage (zero successful tool calls)', async () => {
    // Every call to listTags itself fails (res.ok:false), so no step in the
    // transcript ever has a non-ERROR observation to salvage from.
    runToolMock.mockResolvedValue({ ok: false, error: 'downstream unavailable' });
    queueUpToForcedFinal('listTags');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'what tags do we have?', conversationId: 'conv-1' });

    expect(res.status).toBe('error');
    expect(res.message).toBe('I gathered the details but had trouble summarizing. Please ask again a bit more specifically.');
  });

  it('never fabricates: the salvage message contains only observations that are actually in the step list', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { tags: ['a-real-tag-xyz'] } });
    queueUpToForcedFinal('listTags');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'tags?', conversationId: 'conv-1' });

    expect(res.status).toBe('salvage');
    const succeededObservations = res.steps
      .filter((s) => s.tool && typeof s.observation === 'string' && !s.observation.startsWith('ERROR:'))
      .map((s) => s.observation as string);
    expect(succeededObservations.length).toBeGreaterThan(0);
    // Every line of fact in the message traces back to a real observation —
    // spot-check the concrete value the tool actually returned.
    expect(res.message).toContain('a-real-tag-xyz');
    for (const obs of succeededObservations) {
      // The (possibly truncated) observation text must itself be a prefix of
      // what actually came back — nothing invented in its place.
      expect(obs.startsWith('{"tags":["a-real-tag-xyz"]}')).toBe(true);
    }
  });
});

describe('runAgentStream (streaming) — salvage after forced-final fails (must match runAgentImpl)', () => {
  it('emits a final event carrying the salvage message, flagged salvage:true, not the bare apology', async () => {
    runToolMock.mockResolvedValue({ ok: true, result: { leads: ['lead-42'] } });
    queueUpToForcedFinal('listLeads');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'which leads?', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    const finalEvents = events.filter((e) => e.type === 'final');
    expect(finalEvents.length).toBe(1);
    expect(finalEvents[0].salvage).toBe(true);
    expect(finalEvents[0].message).toContain('List Leads');
    expect(finalEvents[0].message).toContain('lead-42');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('falls back to the plain error event when there is nothing to salvage', async () => {
    runToolMock.mockResolvedValue({ ok: false, error: 'downstream unavailable' });
    queueUpToForcedFinal('listLeads');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'which leads?', conversationId: 'conv-1' },
      (e) => events.push(e),
    );

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.message).toBe('I gathered the details but had trouble summarizing. Please ask again a bit more specifically.');
    expect(events.some((e) => e.type === 'final')).toBe(false);
  });
});

// FIX 2: buildSalvageMessage rendered raw tool observations flat-truncated at
// 400 chars — a batch of drafted outreach emails came through as unreadable
// mid-string JSON. These drive the batch shape (batchObservation's header +
// "[n] ok — "/"[n] FAILED — " lines) and the single-call shape (successObservation's
// "${digest}\n${raw}" / raw-only) through the REAL loop, the same way the
// tests above drive the salvage path itself.
describe('buildSalvageMessage — readable rendering of tool observations', () => {
  it('renders a batch of drafted emails as readable subject + body, not raw JSON (real production shape)', async () => {
    runToolMock.mockImplementation(async (tool: string, _accountId: string, args: any) => {
      if (tool === 'draftOutreach') {
        return {
          ok: true,
          result: {
            subject: 'why viewers abandon product videos early',
            body: 'Hi Markus,\n\nMost e-commerce teams use video to showcase products, but platform analytics only tell you how many people watched, not why they left.\n\nRetentionRail shows exactly where viewers drop off and why.',
          },
        };
      }
      return { ok: true, result: { tags: ['vip'] } };
    });

    const calls = Array.from({ length: 25 }, (_, i) => ({ contactId: `contact-${i + 1}`, goal: 'intro' }));
    generateChat.mockResolvedValueOnce(BATCH_CALL('draftOutreach', calls));
    queueUpToForcedFinal('listTags');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'draft outreach to everyone', conversationId: 'conv-1' });

    expect(res.status).toBe('salvage');
    expect(res.message).toContain('Draft outreach email');
    expect(res.message).toContain('all 25 succeeded');
    expect(res.message).toContain('Subject: why viewers abandon product videos early');
    expect(res.message).toContain('Most e-commerce teams use video');
    // The core defect: the owner could not read a single draft because it
    // was wrapped in raw JSON. Assert that shape is gone.
    expect(res.message).not.toContain('{"subject":');
    // Honest framing preserved.
    expect(res.message).toContain("I wasn't able to put together a final answer");
    expect(res.message).toContain('Ask again, a bit more specifically');
  });

  it('keeps failure reasons visible alongside readable successes (mixed batch)', async () => {
    runToolMock.mockImplementation(async (tool: string, _accountId: string, args: any) => {
      if (tool === 'draftOutreach') {
        const n = Number(args.n);
        if (n % 2 === 0) return { ok: false, error: `contact ${n} has no email on file` };
        return { ok: true, result: { subject: `Subject for contact ${n}`, body: `Body text for contact ${n}.` } };
      }
      return { ok: true, result: { tags: ['vip'] } };
    });

    const calls = Array.from({ length: 10 }, (_, i) => ({ n: i + 1 }));
    generateChat.mockResolvedValueOnce(BATCH_CALL('draftOutreach', calls));
    queueUpToForcedFinal('listTags');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' });

    expect(res.status).toBe('salvage');
    expect(res.message).toContain('5 of 10 succeeded, 5 failed');
    // The readable "Subject: " rendering — not the raw '"subject":"..."'
    // JSON key, which the old flat-truncate renderer would have produced.
    expect(res.message).toContain('Subject: Subject for contact 1');
    expect(res.message).not.toContain('"subject":"Subject for contact 1"');
    expect(res.message).toContain('contact 2 has no email on file');
    expect(res.message).toContain('contact 4 has no email on file');
  });

  it('falls back gracefully for one unparseable item, without losing the rest of the message', async () => {
    runToolMock.mockImplementation(async (tool: string, _accountId: string, args: any) => {
      if (tool === 'draftOutreach') {
        // A capability returning `undefined` as its result is a real,
        // reachable shape: successObservation() has no digest, so the raw
        // observation text becomes the literal, unparseable string
        // "undefined" for this one item.
        if (args.n === 2) return { ok: true, result: undefined };
        return { ok: true, result: { subject: `Subject ${args.n}`, body: `Body ${args.n}` } };
      }
      return { ok: true, result: { tags: ['vip'] } };
    });

    const calls = Array.from({ length: 3 }, (_, i) => ({ n: i + 1 }));
    generateChat.mockResolvedValueOnce(BATCH_CALL('draftOutreach', calls));
    queueUpToForcedFinal('listTags');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' });

    expect(res.status).toBe('salvage');
    expect(res.message).toContain('Subject: Subject 1');
    expect(res.message).toContain('Subject: Subject 3');
    expect(res.message).not.toContain('"subject":"Subject 1"');
    expect(res.message).toContain('undefined');
  });

  // Direct unit test of buildSalvageMessage() for the budget-exceeded path:
  // the full runAgent loop upstream-truncates a step's observation at the
  // SAME OBSERVATION_CHAR_LIMIT buildSalvageMessage uses internally (see
  // loop.ts's `truncate(obs, obsLimit)` at push time), so driving this case
  // through the real loop would exercise that upstream cut rather than
  // buildSalvageMessage's own per-item omission logic. Feeding a hand-built
  // step list — using the exact batchObservation() string shape asserted by
  // the tests above — isolates the one thing this case needs to prove: many
  // items are never silently dropped.
  it('never silently drops items — states an omission count when the per-step budget is exceeded', async () => {
    // Force the module's real OBSERVATION_CHAR_LIMIT (and therefore
    // buildSalvageMessage's stepBudget, which IS that constant) down to a
    // size five ~1KB items cannot all fit in. This is the actual constant
    // the shipped code reads (AGENT_OBSERVATION_CHARS), not a reimplementation
    // of the budget math — resetModules() in beforeEach guarantees a fresh
    // module reads it fresh here.
    process.env.AGENT_OBSERVATION_CHARS = '3000';
    try {
      const { buildSalvageMessage } = await import('@/lib/agent/loop');
      const bigBody = 'A'.repeat(1000);
      const header = 'draftOutreach: all 5 succeeded.';
      const itemLines = Array.from({ length: 5 }, (_, i) =>
        `[${i + 1}] ok — ${JSON.stringify({ subject: `Subject ${i + 1}`, body: bigBody })}`,
      );
      const observation = [header, ...itemLines].join('\n');

      const res = buildSalvageMessage([{ tool: 'draftOutreach', observation }]);

      expect(res).toBeTruthy();
      const msg = res as string;
      expect(msg).toContain('all 5 succeeded');
      expect(msg).toContain('Subject 1');
      // Not every item can fit under a 3,000-char budget when each is over
      // 1,000 chars alone — some must be omitted, and that omission must be
      // stated with a count, never silent.
      expect(msg).not.toContain('Subject 5');
      expect(msg).toMatch(/… and \d+ more/);
    } finally {
      delete process.env.AGENT_OBSERVATION_CHARS;
    }
  });

  // Real shape #1 (owner's transcript): "List leads" — an ARRAY OF RECORDS.
  // capabilityFor() is mocked to return undefined in this file (see the
  // '@/lib/agent/tools' mock above), so this exercises the no-digest path:
  // successObservation() emits raw `JSON.stringify(result)` with nothing in
  // front of it, exactly like a tool with no digest() would in production.
  it('renders a lead LIST as readable records, not raw {"id": JSON (real production shape)', async () => {
    const leads = [
      {
        id: '4eeae0ec-4bf8-4aec-98c5-d716c023af30',
        brand_id: 'retentionrail',
        name: 'Markus Holzinger',
        email: 'markus.holzinger@rwa.at',
        company: 'Lagerhaus Franchise GmbH',
        title: 'E-Commerce-Manager',
        segment: null,
        score: 0,
      },
      {
        id: 'b1111111-2222-3333-4444-555555555555',
        brand_id: 'retentionrail',
        name: 'Julia Berger',
        email: 'julia.berger@example.com',
        company: 'Berger Media',
        title: 'Head of Growth',
        segment: null,
        score: 12,
      },
    ];
    runToolMock.mockResolvedValue({ ok: true, result: leads });
    queueUpToForcedFinal('listLeads');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'list my leads', conversationId: 'conv-1' });

    expect(res.status).toBe('salvage');
    expect(res.message).toContain('List Leads');
    // Readable, per-record fields — the core defect being fixed.
    expect(res.message).toContain('name: Markus Holzinger');
    expect(res.message).toContain('title: E-Commerce-Manager');
    expect(res.message).toContain('company: Lagerhaus Franchise GmbH');
    expect(res.message).toContain('email: markus.holzinger@rwa.at');
    expect(res.message).toContain('name: Julia Berger');
    // The core defect: raw, mid-value-clipped JSON must be gone.
    expect(res.message).not.toContain('{"id":');
    expect(res.message).not.toContain('"brand_id":');
  });

  // Real shape #2 (owner's transcript): "Get sender persona" — a SINGLE
  // OBJECT with several null fields, no digest (getPersona declares none —
  // see lib/capabilities/ventures.ts).
  it('renders a single object (persona) as labelled fields with nulls omitted (real production shape)', async () => {
    runToolMock.mockResolvedValue({
      ok: true,
      result: {
        name: 'RetentionRail',
        role: null,
        email: 'franck@retentionrail.example',
        signature: null,
        pitch: 'For media teams and creator managers who need to cut churn.',
        tone: null,
        defaultCta: 'Book a 15-minute walkthrough',
      },
    });
    queueUpToForcedFinal('getPersona');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'what is our sender persona?', conversationId: 'conv-1' });

    expect(res.status).toBe('salvage');
    expect(res.message).toContain('Get sender persona');
    expect(res.message).toContain('name: RetentionRail');
    expect(res.message).toContain('email: franck@retentionrail.example');
    expect(res.message).toContain('pitch: For media teams and creator managers who need to cut churn.');
    expect(res.message).toContain('defaultCta: Book a 15-minute walkthrough');
    // Null fields must be OMITTED, not printed as "role":null.
    expect(res.message).not.toContain('role');
    expect(res.message).not.toContain('signature');
    expect(res.message).not.toContain('tone');
    expect(res.message).not.toContain('null');
    // The core defect: raw JSON must be gone.
    expect(res.message).not.toContain('"name":');
  });

  it('falls back gracefully for a malformed single (non-batch) payload, without throwing', async () => {
    // A raw observation string that starts with '{' but is not valid JSON —
    // reachable if a capability's digest() ever emitted something JSON-ish
    // that doesn't actually parse. Must degrade to the truncated-text
    // fallback for this step, not throw and lose the whole salvage message.
    runToolMock.mockResolvedValue({ ok: true, result: 'not-json-shaped-string-result' });
    queueUpToForcedFinal('listTags');
    generateChat.mockRejectedValueOnce(new Error('provider ladder exhausted'));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'tags?', conversationId: 'conv-1' });

    expect(res.status).toBe('salvage');
    expect(res.message).toContain('List Tags');
    expect(res.message).toContain('not-json-shaped-string-result');
  });
});

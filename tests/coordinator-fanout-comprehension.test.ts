// Three defects found from one production trace: a 34,456-character document
// was attached, the trace showed delegates being convened ("Bringing in Milo
// and Ezra… Milo is working on the messaging…") and then the turn died with no
// terminal event — and nothing in the trace, at any point, said the document
// had been read.
//
// Root causes, all in lib/agent/loop.ts:
//   Defect 2 — resolveCoordinatorFanout's AUTO-selection path
//     (selectPersonasForRequest) was handed only the raw user sentence, never
//     the attached material, so WHO gets picked cannot see what the request is
//     actually about.
//   Defect 3 — the fan-out branch pre-empted the ReAct loop entirely (an early
//     `return`), so comprehension never happened before delegation was decided,
//     and nothing in the trace showed the document being considered.
//   Defect 4 — every delegate received `agentContext: input.agentContext`
//     verbatim: the full document, duplicated into N concurrent prompts.
//
// These tests drive the REAL runAgent / runAgentStream loop (mocked
// dependencies only) rather than re-implementing the control flow, per the
// house rule in CLAUDE.md ("extract for testability when the defect is in the
// path, not the parts").

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const generateChat = vi.fn();
const runTool = vi.fn();
let selectPersonasCalls: { message: string }[] = [];
let selectPersonasImpl: (accountId: string, message: string, max: number) => Promise<any[]>;
let resolveMentionedImpl: (accountId: string, mentions: string[]) => Promise<any[]>;

const COORDINATOR = { id: 'coord-1', name: 'Ada', role: 'Coordinator', is_coordinator: true, enabled: true, model_id: null };
const MILO = { id: 'p-milo', name: 'Milo', role: 'Copywriter', is_coordinator: false, enabled: true, model_id: null };
const EZRA = { id: 'p-ezra', name: 'Ezra', role: 'Lifecycle', is_coordinator: false, enabled: true, model_id: null };

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: {},
  runTool: (...a: any[]) => runTool(...a),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  capabilityFor: () => undefined,
  toolsFromCapabilities: () => ({}),
}));
vi.mock('@/lib/capabilities/external-mcp', () => ({ loadExternalCapabilities: async () => [] }));
vi.mock('@/lib/agent/personas', () => ({
  loadPersonaForAgent: async () => null,
  resolveMentionedPersonas: async (accountId: string, mentions: string[]) => resolveMentionedImpl(accountId, mentions),
  getCoordinator: async () => COORDINATOR,
  selectPersonasForRequest: async (accountId: string, message: string, max: number) => {
    selectPersonasCalls.push({ message });
    return selectPersonasImpl(accountId, message, max);
  },
  buildPersonaSystemBlock: () => '',
  buildCoordinatorSystemBlock: () => 'You are the coordinator.',
  parseMentions: () => [],
}));
vi.mock('@/lib/skills/store', () => ({ loadEnabledSkillsForAgent: async () => [] }));
vi.mock('@/lib/agent/compose', () => ({ composeAnswer: async (a: any) => a?.draft ?? '' }));
vi.mock('@/lib/approvals/store', () => ({
  createApproval: async () => null,
  consumeApprovalForExecution: vi.fn(),
  markApprovedByToolAndArgs: vi.fn(),
  recordExecutedApproval: vi.fn(),
  ApprovalExecutionError: class extends Error {},
}));
vi.mock('@/lib/approvals/grants', () => ({ consumeGrant: async () => null, isGrantable: () => false }));
vi.mock('@/lib/capabilities/delegation', () => ({
  beginDelegationScope: vi.fn(), endDelegationScope: vi.fn(), setDelegationContext: vi.fn(),
}));
vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: async () => ({ skillIds: [] }) }));
vi.mock('@/lib/credits', () => ({ markParseOutcome: vi.fn(), recordAiUsage: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));
// Real module (not mocked): lib/documents/attachments — but it reaches @/lib/db
// and @/lib/storage at import time, so those still need a safe stub.
vi.mock('@/lib/storage', () => ({
  putPrivate: vi.fn(), signUrl: vi.fn(), ensurePrivateBucket: vi.fn(),
}));
vi.mock('@/lib/ai/deck', () => ({ extractDeckText: vi.fn(), isSupportedDeck: () => false }));

const FINAL = JSON.stringify({ action: 'final', message: 'Delegate answer.' });

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  generateChat.mockResolvedValue(FINAL); // every route-pass AND synthesis call just answers
  runTool.mockReset();
  selectPersonasCalls = [];
  selectPersonasImpl = async () => []; // no auto fan-out unless a test opts in
  resolveMentionedImpl = async () => []; // no explicit mentions unless a test opts in
});

// A document big enough to be the thing the evidence in the bug report
// described (34,456 chars), with a marker word buried inside it that is NOT
// in the user's own sentence — so any test asserting the marker reached a
// downstream consumer is proof that consumer saw the DOCUMENT, not just the
// message.
const MARKER = 'ZYXQ_DIGEST_MARKER';
const END_MARKER = 'ZYXQ_END_OF_DOCUMENT_MARKER';
function bigAttachmentContext(): string {
  const body = `${MARKER} — quarterly outreach brief.\n`
    + 'Lorem ipsum dolor sit amet. '.repeat(1200)
    + END_MARKER; // unique, appears exactly once — proves truncation rather than just size
  return [
    'ABOUT LEADRAIL (the platform you operate):\nsome static grounding here',
    [
      'ATTACHED DOCUMENTS — the user attached these to this conversation.',
      '',
      '--- BEGIN DOCUMENT: brief.txt (txt, 34456 bytes, attached to this conversation) ---',
      body,
      '--- END DOCUMENT: brief.txt ---',
      '',
    ].join('\n'),
  ].join('\n\n');
}

// contextCharBudget() defaults to a multi-MEGABYTE allowance (derived from a
// 1M-token window — see lib/ai/context-budget.ts) precisely so a real
// attachment is never truncated for a single ordinary turn. A 34k-character
// test document sits comfortably under that by design, so demonstrating that
// delegateContext() actually DIVIDES the budget needs a small budget to divide
// — the same ATTACHMENT_CONTEXT_CHARS override contextCharBudget() itself
// reads at call time. This does not change what production ships with; it
// makes the division visible in a test the same way any budget-scaling test
// would.
const ORIGINAL_BUDGET_ENV = process.env.ATTACHMENT_CONTEXT_CHARS;
function withSmallBudget(chars: string) { process.env.ATTACHMENT_CONTEXT_CHARS = chars; }
function restoreBudgetEnv() {
  if (ORIGINAL_BUDGET_ENV === undefined) delete process.env.ATTACHMENT_CONTEXT_CHARS;
  else process.env.ATTACHMENT_CONTEXT_CHARS = ORIGINAL_BUDGET_ENV;
}

describe('attachmentDigest / delegateContext (pure helpers)', () => {
  it('extracts a bounded excerpt starting at the attachment marker, not the whole thing', async () => {
    const { attachmentDigest } = await import('@/lib/agent/loop');
    const ctx = bigAttachmentContext();
    const digest = attachmentDigest(ctx, 1200);
    expect(digest.length).toBeLessThanOrEqual(1200);
    expect(digest).toContain('ATTACHED DOCUMENTS');
    expect(digest).toContain(MARKER);
    // The digest must be dramatically smaller than the source document — this
    // is the "do NOT push 34k characters into a routing prompt" requirement.
    expect(digest.length).toBeLessThan(ctx.length / 10);
  });

  it('is empty when nothing is attached, even with a large agentContext', async () => {
    const { attachmentDigest } = await import('@/lib/agent/loop');
    expect(attachmentDigest('ABOUT LEADRAIL: plain grounding, no attachments here.', 1200)).toBe('');
    expect(attachmentDigest(undefined, 1200)).toBe('');
  });

  // PRODUCTION DEFECT (2026-08-28): delegateContext used to divide the
  // per-turn budget by delegateCount, on the theory N delegates shared one
  // pool. They do not — each delegate is an INDEPENDENT model call with its
  // own context window, so dividing meant a 3-delegate fan-out gave each
  // delegate a THIRD of the material a 1-delegate turn would see (always the
  // same opening slice), which is why delegates in production disagreed with
  // each other on the same question (60 / 25 / 24 / 22 / 20 leads reported
  // for one conversation). This test used to assert the OLD, buggy shrinking
  // behaviour directly (`forThree.length` < `forOne.length`); it now asserts
  // the fix — each delegate gets the SAME full per-call budget regardless of
  // how many delegates are in the fan-out.
  it('gives every delegate the SAME per-call document budget, independent of fan-out size', async () => {
    withSmallBudget('9000'); // see comment above withSmallBudget
    try {
      const { delegateContext } = await import('@/lib/agent/loop');
      const ctx = bigAttachmentContext();
      const forOne = delegateContext(ctx, 1)!;
      const forThree = delegateContext(ctx, 3)!;
      // The slice size must NOT shrink as the team grows — three delegates
      // each get exactly what one delegate would get, because they are three
      // independent calls, not three shares of one call.
      expect(forThree.length).toBe(forOne.length);
      // The bound still binds at realistic sizes (contextCharBudget() here is
      // deliberately small — 9000 — via withSmallBudget), so a delegate does
      // NOT receive the whole 34k document verbatim.
      expect(forOne.length).toBeLessThan(ctx.length);
    } finally {
      restoreBudgetEnv();
    }
  });

  it('does not shrink a single delegate slice below DELEGATE_MATERIAL_CHARS just because the fan-out is larger', async () => {
    // A mid-size budget (40,000) is deliberately chosen here, NOT the real
    // multi-megabyte default: at the real default, contextCharBudget() is so
    // large that DELEGATE_MATERIAL_CHARS (16,000) is always the binding cap
    // regardless of delegateCount, even under the OLD buggy division — for
    // every realistic fan-out size (MAX_FANOUT_DELEGATES=3),
    // floor(hugeBudget/3) still vastly exceeds 16,000, so a revert-check
    // against the real default would falsely stay green whether the division
    // bug is present or fixed. 40,000/4 = 10,000, which sits BELOW
    // DELEGATE_MATERIAL_CHARS, so this budget actually distinguishes: fixed
    // code gives every delegate the full min(16000, 40000)=16000 regardless
    // of count; the old buggy division would shrink a 4-delegate slice to
    // 10,000.
    withSmallBudget('40000');
    try {
      const { delegateContext } = await import('@/lib/agent/loop');
      const ctx = bigAttachmentContext();
      const forOne = delegateContext(ctx, 1)!;
      const forFour = delegateContext(ctx, 4)!;
      expect(forFour.length).toBe(forOne.length);
      // Sanity: the document slice itself is exactly DELEGATE_MATERIAL_CHARS
      // (16,000), not the 40,000 budget — confirms the cap that's binding
      // here is the per-delegate ceiling, not contextCharBudget().
      const head = 'ABOUT LEADRAIL (the platform you operate):\nsome static grounding here\n\n'.length;
      expect(forOne.length - head).toBe(16_000);
    } finally {
      restoreBudgetEnv();
    }
  });

  it('leaves the static grounding sections (everything before the marker) untouched', async () => {
    const { delegateContext } = await import('@/lib/agent/loop');
    const ctx = bigAttachmentContext();
    const bounded = delegateContext(ctx, 3)!;
    expect(bounded.startsWith('ABOUT LEADRAIL (the platform you operate):\nsome static grounding here')).toBe(true);
  });
});

describe('Defect 2 — auto-selection sees the attached material, not just the sentence', () => {
  it('folds a digest of the attachment into the text selectPersonasForRequest scores against', async () => {
    selectPersonasImpl = async () => [MILO, EZRA]; // pretend the digest content matched two personas
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({
      accountId: 'acct-1',
      message: "Take a look at this document, analyze it, and let's start working on the plan.",
      agentContext: bigAttachmentContext(),
    });
    expect(selectPersonasCalls.length).toBeGreaterThan(0);
    // The raw message alone never contains the marker — only the digest does.
    expect(selectPersonasCalls[0].message).toContain(MARKER);
  });

  it('routes on the bare message when nothing is attached (unchanged behavior)', async () => {
    selectPersonasImpl = async () => [];
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'draft a follow-up email' });
    expect(selectPersonasCalls.length).toBeGreaterThan(0);
    expect(selectPersonasCalls[0].message).toBe('draft a follow-up email');
  });
});

describe('Defect 3 — an auto-selected fan-out does not bypass comprehension', () => {
  it('emits a visible "reading the attached material" step before any delegate is announced', async () => {
    selectPersonasImpl = async () => [MILO, EZRA];
    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'analyze this and plan outreach', agentContext: bigAttachmentContext() },
      (e) => events.push(e),
    );
    const readingIdx = events.findIndex((e) => e.type === 'thought' && /reading the attached material/i.test(e.text));
    const firstDelegateIdx = events.findIndex((e) => e.type === 'step_start' && e.parallel);
    expect(readingIdx).toBeGreaterThanOrEqual(0);
    expect(firstDelegateIdx).toBeGreaterThanOrEqual(0);
    expect(readingIdx).toBeLessThan(firstDelegateIdx);
  });

  it('does not emit the reading step (and does not fan out) when there is nothing attached', async () => {
    selectPersonasImpl = async () => [MILO, EZRA]; // would fan out IF given the chance
    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    await runAgentStream(
      { accountId: 'acct-1', message: 'draft a follow-up email' },
      (e) => events.push(e),
    );
    expect(events.some((e) => e.type === 'thought' && /reading the attached material/i.test(e.text))).toBe(false);
  });

  it('a normal (non-fanout) turn still reasons over the FULL attached document, not a digest', async () => {
    selectPersonasImpl = async () => []; // fewer than 2 — no fan-out, falls through to the ordinary loop
    const { runAgent } = await import('@/lib/agent/loop');
    const ctx = bigAttachmentContext();
    await runAgent({ accountId: 'acct-1', message: 'summarize this document', agentContext: ctx });
    // The ordinary single-agent system prompt is built from input.agentContext
    // verbatim (systemPrompt(..., input.agentContext, ...)) — comprehension of
    // the full document is unchanged for the path that isn't delegating. A
    // comprehension-pass call runs FIRST now (over the material, not the
    // system prompt) before the fan-out gate falls through to this ordinary
    // loop, so this looks across every call rather than assuming index 0.
    const call = generateChat.mock.calls.map((c) => c[0]).find((c) => String(c?.system || '').includes(MARKER));
    expect(call).toBeTruthy();
  });
});

describe('Defect 4 — delegate context is bounded, not N full copies', () => {
  it('each delegate receives a bounded slice, not the whole document verbatim', async () => {
    withSmallBudget('9000'); // see comment on withSmallBudget above — makes the bound observable
    try {
      selectPersonasImpl = async () => [MILO, EZRA];
      const { runAgent } = await import('@/lib/agent/loop');
      const ctx = bigAttachmentContext();
      await runAgent({ accountId: 'acct-1', message: 'analyze this and plan outreach', agentContext: ctx });

      // Every generateChat call in this turn belongs to a delegate's own route
      // pass (or the synthesis pass) — none of them should carry the full
      // 34k-character document. Two delegates were convened, so if the fix
      // were absent every one of these system prompts would contain the
      // ENTIRE document body, duplicated.
      const systemPrompts = generateChat.mock.calls.map((c) => String(c[0]?.system || ''));
      expect(systemPrompts.length).toBeGreaterThan(0);
      for (const sys of systemPrompts) {
        if (!sys.includes(MARKER)) continue; // the synthesis call carries no agentContext at all
        expect(sys.length).toBeLessThan(ctx.length);
      }
    } finally {
      restoreBudgetEnv();
    }
  });

  it('the marker text is truncated away rather than reaching a delegate in full', async () => {
    withSmallBudget('9000');
    try {
      selectPersonasImpl = async () => [MILO, EZRA];
      const { runAgent } = await import('@/lib/agent/loop');
      const ctx = bigAttachmentContext();
      await runAgent({ accountId: 'acct-1', message: 'analyze this and plan outreach', agentContext: ctx });
      const systemPrompts = generateChat.mock.calls.map((c) => String(c[0]?.system || ''));
      // The document's opening MARKER sits right after the BEGIN DOCUMENT
      // line, well inside the small 9000-char budget divided by two delegates
      // (~4500 each) — so it still reaches them. END_MARKER sits at the very
      // end of the 34k-character document, well past that per-delegate slice
      // — so seeing MARKER but not END_MARKER is exactly what truncation
      // (rather than the full document) looks like.
      for (const sys of systemPrompts) {
        if (!sys.includes(MARKER)) continue;
        expect(sys).not.toContain(END_MARKER);
      }
    } finally {
      restoreBudgetEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// The comprehension pass (lib/agent/comprehension.ts) — added after the tests
// above shipped, once a live reproduction against the REAL production
// transcript (tests/fixtures/meeting-transcript.txt, copied verbatim from the
// file that produced the trace in the bug report) showed the digest-based fix
// above was not enough: a 1,200-character HEAD SLICE of a 34,649-character
// pitch/demo/Q&A transcript is dominated by the caller's opening small talk
// ("we are equity agency… over 20 million kind of Euros in revenue…"), which
// is exactly the money-and-agency vocabulary that mis-routed the turn to a
// numbers persona and a spend persona in production.
// ---------------------------------------------------------------------------

const REAL_TRANSCRIPT = readFileSync(
  path.join(__dirname, 'fixtures', 'meeting-transcript.txt'),
  'utf8',
);

// A stand-in for a real comprehension response, grounded in what the real
// transcript is ACTUALLY about (a creator-analytics product pitch, live demo,
// and investor Q&A) rather than its opening sentence.
const PITCH_UNDERSTANDING = {
  ask: 'Analyse the attached sales call transcript.',
  askType: 'analyse',
  material: {
    kind: 'sales call transcript',
    subject: 'a creator-analytics product pitch, live demo, and investor Q&A',
    participants: ['Speaker 1', 'Speaker 2'],
    keyPoints: ['Pitches a creator-analytics dashboard product', 'Walks through a live product demo', 'Investor Q&A on the product and market'],
  },
  outputShape: 'a summary of the pitch, demo, and open questions',
  needs: ['product analysis', 'copywriting'],
};

/** Route every generateChat call through: comprehension-shaped requests (the
 *  comprehend() system prompt) get `understandingJson`; everything else (a
 *  delegate's own ReAct route pass, the coordinator's synthesis pass) gets
 *  the ordinary FINAL envelope. Mirrors production exactly: comprehend() and
 *  the agent loop's route pass share the same generateChat, distinguished
 *  only by what they ask for. */
function mockComprehensionAs(understandingJson: any | null) {
  generateChat.mockImplementation(async (opts: any) => {
    if (/comprehension pass/i.test(String(opts?.system || ''))) {
      if (understandingJson === null) throw new Error('comprehension call failed');
      return JSON.stringify(understandingJson);
    }
    return FINAL;
  });
}

function bigAttachmentContextFrom(body: string): string {
  return [
    'ABOUT LEADRAIL (the platform you operate):\nsome static grounding here',
    [
      'ATTACHED DOCUMENTS — the user attached these to this conversation.',
      '',
      '--- BEGIN DOCUMENT: transcript.txt (txt, 34649 bytes, attached to this conversation) ---',
      body,
      '--- END DOCUMENT: transcript.txt ---',
      '',
    ].join('\n'),
  ].join('\n\n');
}

describe('comprehension pass — the regression, reproduced against the real transcript', () => {
  it('routes on the SUBSTANCE of the real transcript, never on its opening small talk', async () => {
    mockComprehensionAs(PITCH_UNDERSTANDING);
    selectPersonasImpl = async () => [MILO, EZRA];
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({
      accountId: 'acct-1',
      message: 'analyse this transcript',
      agentContext: bigAttachmentContextFrom(REAL_TRANSCRIPT),
    });
    expect(selectPersonasCalls.length).toBeGreaterThan(0);
    const routingText = selectPersonasCalls[0].message;
    // Reflects the substance a real comprehension pass would have found...
    expect(routingText).toContain('creator-analytics');
    expect(routingText).toContain('product demo');
    // ...and is NOT dominated by the caller's opening lines about an equity
    // agency and Euros in revenue — the literal defect from the bug report.
    expect(routingText).not.toMatch(/equity agency/i);
    expect(routingText).not.toMatch(/Euros in revenue/i);
  });

  it('comprehension failure falls back cleanly — the turn still runs to completion', async () => {
    mockComprehensionAs(null); // comprehend() throws internally; must degrade, never throw out
    selectPersonasImpl = async () => []; // fewer than 2 -> ordinary single-agent path
    const { runAgent } = await import('@/lib/agent/loop');
    const result = await runAgent({
      accountId: 'acct-1',
      message: 'analyse this transcript',
      agentContext: bigAttachmentContextFrom(REAL_TRANSCRIPT),
    });
    // No throw, and the turn produced a real result — the whole point of
    // "a failed comprehension must never fail the turn".
    expect(result.status).not.toBe('error');
    expect(selectPersonasCalls.length).toBeGreaterThan(0);
  });

  it('a single-capability understanding does not fan out — one job for one agent', async () => {
    mockComprehensionAs({ ...PITCH_UNDERSTANDING, needs: ['product analysis'] });
    // Even if persona-selection WOULD match two personas, a single-capability
    // `needs` must never reach it — the fan-out decision is made from `needs`
    // before selectPersonasForRequest is ever called.
    selectPersonasImpl = async () => [MILO, EZRA];
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({
      accountId: 'acct-1',
      message: 'analyse this transcript',
      agentContext: bigAttachmentContextFrom(REAL_TRANSCRIPT),
    });
    // selectPersonasForRequest was never reached at all for the auto path.
    expect(selectPersonasCalls.length).toBe(0);
  });

  it('a multi-capability understanding still requires selectPersonasForRequest to find 2+ personas', async () => {
    mockComprehensionAs(PITCH_UNDERSTANDING); // needs: ['product analysis', 'copywriting']
    selectPersonasImpl = async () => [MILO]; // only one persona actually matches
    const { runAgent } = await import('@/lib/agent/loop');
    const result: any = await runAgent({
      accountId: 'acct-1',
      message: 'analyse this transcript',
      agentContext: bigAttachmentContextFrom(REAL_TRANSCRIPT),
    });
    expect(selectPersonasCalls.length).toBeGreaterThan(0);
    // One match is a specialist question, not a team question.
    expect(result.status).not.toBe('needs_approval');
  });

  it('an explicit multi-@mention still fans out unconditionally, bypassing comprehension entirely', async () => {
    mockComprehensionAs(null); // if comprehension ran and failed, this proves it was never called
    resolveMentionedImpl = async () => [MILO, EZRA]; // the user named the team explicitly
    const runAgentLoop = await import('@/lib/agent/loop');
    const result: any = await runAgentLoop.runAgent({
      accountId: 'acct-1',
      message: 'analyse this with @Milo @Ezra',
      personaMentions: ['Milo', 'Ezra'],
      agentContext: bigAttachmentContextFrom(REAL_TRANSCRIPT),
    });
    // No comprehension-shaped call was made — every generateChat call in this
    // turn was a route-pass or synthesis call, not a "comprehension pass" one.
    const comprehensionCalls = generateChat.mock.calls.filter((c: any[]) => /comprehension pass/i.test(String(c[0]?.system || '')));
    expect(comprehensionCalls.length).toBe(0);
    expect(result.status).not.toBe('error');
  });

  it('delegateContext bounds at realistic sizes — a 35k block with 2 delegates does NOT yield 35k each', async () => {
    // Deliberately NOT overriding ATTACHMENT_CONTEXT_CHARS here: this is the
    // realistic, un-tuned production default (a multi-megabyte allowance
    // derived from a 1M-token window), which is exactly the case where the
    // OLD delegateContext() silently handed each delegate the entire 35k
    // document — the division by delegate count never bound at that size.
    const { delegateContext } = await import('@/lib/agent/loop');
    const ctx = bigAttachmentContextFrom(REAL_TRANSCRIPT);
    const forTwo = delegateContext(ctx, 2)!;
    expect(forTwo.length).toBeLessThan(REAL_TRANSCRIPT.length);
    // Specifically: nowhere near the full 34,649-character document.
    expect(forTwo.length).toBeLessThan(20_000);
  });

  it('each delegate receives the comprehended understanding, not just a raw slice', async () => {
    mockComprehensionAs(PITCH_UNDERSTANDING);
    selectPersonasImpl = async () => [MILO, EZRA];
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({
      accountId: 'acct-1',
      message: 'analyse this transcript',
      agentContext: bigAttachmentContextFrom(REAL_TRANSCRIPT),
    });
    const delegateSystemPrompts = generateChat.mock.calls
      .map((c: any[]) => String(c[0]?.system || ''))
      .filter((sys: string) => sys.includes('TASK UNDERSTANDING') || sys.includes('creator-analytics'));
    expect(delegateSystemPrompts.length).toBeGreaterThan(0);
  });
});

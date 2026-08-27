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

const generateChat = vi.fn();
const runTool = vi.fn();
let selectPersonasCalls: { message: string }[] = [];
let selectPersonasImpl: (accountId: string, message: string, max: number) => Promise<any[]>;

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
  resolveMentionedPersonas: async () => [],
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

  it('divides the SAME per-turn attachment budget across delegates instead of giving each one the full document', async () => {
    withSmallBudget('9000'); // see comment above withSmallBudget
    try {
      const { delegateContext } = await import('@/lib/agent/loop');
      const { contextCharBudget } = await import('@/lib/documents/attachments');
      const ctx = bigAttachmentContext();
      const forOne = delegateContext(ctx, 1)!;
      const forThree = delegateContext(ctx, 3)!;
      // Each individual delegate's slice shrinks as the fan-out grows...
      expect(forThree.length).toBeLessThan(forOne.length);
      // ...and a single delegate does NOT receive the whole 34k document
      // verbatim once the budget is smaller than the document.
      expect(forOne.length).toBeLessThan(ctx.length);
      // ...and three delegates' worth of document text together does not
      // exceed what ONE ordinary turn is already allowed to read (plus the
      // untouched static-grounding head each copy also carries) — the
      // property that stops a fan-out from broadcasting N full copies.
      const budget = contextCharBudget();
      const head = 'ABOUT LEADRAIL (the platform you operate):\nsome static grounding here\n\n'.length;
      expect(forThree.length * 3).toBeLessThanOrEqual(budget + 3 * head + 500);
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
    // the full document is unchanged for the path that isn't delegating.
    const call = generateChat.mock.calls[0]?.[0];
    expect(call.system).toContain(MARKER);
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

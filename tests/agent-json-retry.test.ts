// When the route pass breaks the JSON contract, two things used to be lost.
//
// 1. The offending text. It was dropped at `continue`, so the nudge said "your
//    last reply was not valid JSON" while that reply was absent from the
//    model's own context — and gone from the transcript for good. Seven real
//    failures were recovered from production transcripts by finding these
//    nudges; not one had the output attached.
// 2. The fact that it happened at all. The router had already logged ok=true,
//    because the transport DID succeed.
//
// These drive the REAL runAgent loop — not a reimplementation — and assert on
// the transcript it returns and the parse_ok it reports.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const markParseOutcome = vi.fn();
const warn = vi.fn();

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/credits', () => ({
  markParseOutcome: (...a: any[]) => markParseOutcome(...a),
  recordAiUsage: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: (...a: any[]) => warn(...a), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: {},
  runTool: vi.fn(),
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
// Faithful stub: the real compose pass REWRITES the route pass's draft, so a
// stub returning '' would blank every final message and hide real regressions.
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
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));

const FINAL = JSON.stringify({ action: 'final', message: 'All done.' });

async function run(replies: string[]) {
  for (const r of replies) generateChat.mockResolvedValueOnce(r);
  const { runAgent } = await import('@/lib/agent/loop');
  return runAgent({ accountId: 'acct-1', message: 'hi', conversationId: 'conv-1' });
}

describe('JSON-contract failure is no longer discarded', () => {
  beforeEach(() => {
    vi.resetModules();
    generateChat.mockReset();
    markParseOutcome.mockReset();
    warn.mockReset();
  });

  it('keeps the failing reply in the transcript, as the assistant, BEFORE the nudge', async () => {
    const prose = "Sure! I'll look into those agencies for you.";
    const res = await run([prose, FINAL]);

    const idx = res.transcript.findIndex(
      (m) => m.role === 'user' && m.content.includes('Respond with ONLY one JSON object'),
    );
    expect(idx, 'a nudge should have been issued').toBeGreaterThan(-1);

    const echoed = res.transcript[idx - 1];
    expect(echoed.role).toBe('assistant');
    expect(echoed.content).toContain('look into those agencies');
  });

  it('records the failure as a warning, so a retry-rescued turn is still countable', async () => {
    await run(["I'd be happy to help!", FINAL]);
    const hit = warn.mock.calls.find((c) => String(c[0]).includes('failed JSON contract'));
    expect(hit, 'expected a persisted warn line').toBeTruthy();
    expect(hit![1]).toMatchObject({ attempt: 1, accountId: 'acct-1' });
    expect(hit![1].rawPreview).toContain('happy to help');
  });

  it('truncates a runaway reply instead of letting it flood the transcript', async () => {
    const huge = 'x'.repeat(50_000);
    const res = await run([huge, FINAL]);
    const echoed = res.transcript.find((m) => m.role === 'assistant' && m.content.startsWith('xxx'));
    expect(echoed).toBeTruthy();
    expect(echoed!.content.length).toBeLessThan(5_000);
  });

  it('still recovers: a valid envelope after the nudge finishes the turn', async () => {
    const res = await run(['not json at all', FINAL]);
    expect(res.status).toBe('done');
    expect(res.message).toContain('All done.');
  });
});

describe('parse_ok separates transport success from a usable response', () => {
  beforeEach(() => {
    vi.resetModules();
    generateChat.mockReset();
    markParseOutcome.mockReset();
    warn.mockReset();
  });

  /** Simulate a tier answering: the router hands the row id over via
   *  onUsageRow before generateChat resolves. */
  function answerWith(replies: string[], rowId: string | null) {
    const queue = [...replies];
    generateChat.mockImplementation(async (opts: any) => {
      if (rowId) opts.onUsageRow?.(rowId);
      return queue.shift() ?? FINAL;
    });
  }

  it('reports parse_ok=false for a response that came back but could not be used', async () => {
    answerWith(['this is prose, not an envelope', FINAL], 'row-1');
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'hi' });

    expect(markParseOutcome).toHaveBeenCalledWith('row-1', false);
    expect(markParseOutcome).toHaveBeenCalledWith('row-1', true);
  });

  it('does not mark anything when the router reported no row id', async () => {
    answerWith([FINAL], null);
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'hi' });
    expect(markParseOutcome).not.toHaveBeenCalled();
  });
});

// An ordinary turn reasons over the FULL attached document.
//
// PRESERVED COVERAGE. This assertion used to live in
// tests/coordinator-fanout-comprehension.test.ts ("a normal (non-fanout) turn
// still reasons over the FULL attached document, not a digest"). That file was
// deleted along with the coordinator fan-out it existed to test, but THIS
// property is not about the fan-out at all: it is about the ordinary
// single-agent path, which is now the only path. Deleting it with the rest of
// the file would have silently dropped the one guarantee in there that still
// has a subject.
//
// What it protects: systemPrompt() is built from input.agentContext verbatim,
// so the whole attached document reaches the answering model. The digest
// helpers (attachmentDigest / delegateContext) that used to truncate it for
// routing and for delegates are gone; nothing should be truncating an ordinary
// turn's material.

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
  getCoordinator: async () => null,
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
vi.mock('@/lib/storage', () => ({
  putPrivate: vi.fn(), signUrl: vi.fn(), ensurePrivateBucket: vi.fn(),
}));
vi.mock('@/lib/ai/deck', () => ({ extractDeckText: vi.fn(), isSupportedDeck: () => false }));

const FINAL = JSON.stringify({ action: 'final', message: 'Answer.' });

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  generateChat.mockResolvedValue(FINAL);
  runTool.mockReset();
});

// A marker buried inside the document body and NOT present in the user's own
// sentence: any consumer that echoes it saw the DOCUMENT, not just the message.
// END_MARKER appears exactly once, at the very end, so its presence proves the
// material was not truncated rather than merely large.
const MARKER = 'ZYXQ_DIGEST_MARKER';
const END_MARKER = 'ZYXQ_END_OF_DOCUMENT_MARKER';

function bigAttachmentContext(): string {
  const body = `${MARKER} — quarterly outreach brief.\n`
    + 'Lorem ipsum dolor sit amet. '.repeat(1200)
    + END_MARKER;
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

describe('an ordinary turn reasons over the full attached document', () => {
  it('puts the whole document in the system prompt, head to tail', async () => {
    const { runAgent } = await import('@/lib/agent/loop');
    const ctx = bigAttachmentContext();
    await runAgent({ accountId: 'acct-1', message: 'summarize this document', agentContext: ctx });

    const call = generateChat.mock.calls
      .map((c) => c[0])
      .find((c) => String(c?.system || '').includes(MARKER));
    expect(call).toBeTruthy();
    // The tail matters as much as the head: a head-slice would carry MARKER
    // and drop END_MARKER, which is exactly the truncation being ruled out.
    expect(String(call.system)).toContain(END_MARKER);
  });

  it('keeps the static grounding sections ahead of the attachment', async () => {
    const { runAgent } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'summarize this', agentContext: bigAttachmentContext() });

    const call = generateChat.mock.calls
      .map((c) => c[0])
      .find((c) => String(c?.system || '').includes(MARKER));
    expect(call).toBeTruthy();
    const system = String(call.system);
    expect(system).toContain('ABOUT LEADRAIL');
    expect(system.indexOf('ABOUT LEADRAIL')).toBeLessThan(system.indexOf(MARKER));
  });
});

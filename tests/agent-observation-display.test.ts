// THE ACTUAL WIRING DEFECT (production, today): the live SSE trace a person
// watches while a turn runs (src/components/AgentConsole.tsx's `observation`
// event handler) used to display `emit({ type: 'observation', text: ... })`
// completely untouched, truncated only to 240 chars on the client. That is
// what showed
//
//     No documents are saved to the library. {"documents":[]}
//
// — lib/agent/observation-render.ts (renderObservation) already existed and
// already rendered payloads readably, but its ONLY caller was
// buildSalvageMessage(): a path that only ever runs on a forced-final
// failure, never on an ordinary successful tool call. Every normal turn's
// live trace bypassed it entirely.
//
// This drives the REAL loop (runAgentStream — "the streaming one is what
// real chat turns run", CLAUDE.md) and asserts the `observation` SSE event's
// `text` is now readable prose, not the raw JSON the tool actually returned.

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
  TOOLS: { listDocuments: { title: 'List saved documents', sensitive: false } },
  runTool: (...a: any[]) => runTool(...a),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  // No digest declared here — this deliberately exercises the DIGEST-LESS
  // path (successObservation() falling back to raw JSON alone), which is the
  // harder case: nothing but the shape-based fallback stands between the raw
  // payload and the person watching the trace.
  capabilityFor: (n: string) => (n === 'listDocuments' ? { gate: 'read' } : undefined),
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
  createApproval: vi.fn(), consumeApprovalForExecution: vi.fn(), markApprovedByToolAndArgs: vi.fn(),
  ApprovalExecutionError: class extends Error {},
}));
vi.mock('@/lib/capabilities/delegation', () => ({
  beginDelegationScope: vi.fn(), endDelegationScope: vi.fn(), setDelegationContext: vi.fn(),
}));
vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: async () => ({ skillIds: [] }) }));
vi.mock('@/lib/credits', () => ({ markParseOutcome: vi.fn(), recordAiUsage: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));

const CALL_LIST_DOCUMENTS = JSON.stringify({
  plan: 'Check what is saved to the library.',
  narration: 'Checking what you have saved',
  action: 'tool',
  tool: 'listDocuments',
  args: {},
});
const FINAL = JSON.stringify({ plan: 'Told them.', narration: 'Answering…', action: 'final', message: 'Nothing is saved yet.' });

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runTool.mockReset();
});

const runStream = async () => {
  const { runAgentStream } = await import('@/lib/agent/loop');
  const events: any[] = [];
  await runAgentStream({ accountId: 'acct-1', message: 'do I have anything saved?', conversationId: 'conv-1' }, (e) => events.push(e));
  return events;
};

describe('the live trace renders a digest-less tool result as prose, not raw JSON', () => {
  it('the exact production case: {documents:[]} shows no JSON in the observation event', async () => {
    runTool.mockResolvedValueOnce({ ok: true, result: { documents: [] } });
    generateChat.mockResolvedValueOnce(CALL_LIST_DOCUMENTS).mockResolvedValueOnce(FINAL);
    const events = await runStream();

    const obs = events.find((e) => e.type === 'observation');
    expect(obs).toBeTruthy();
    // This is the literal production defect line. It must be gone.
    expect(obs.text).not.toContain('{"documents":[]}');
    expect(obs.text).not.toContain('{"');
    expect(obs.text.toLowerCase()).toMatch(/no documents/);
  });

  it('a populated list still names the count, not a JSON array', async () => {
    runTool.mockResolvedValueOnce({
      ok: true,
      result: { documents: [{ id: 'd1', name: 'Brand book' }, { id: 'd2', name: 'Price list' }] },
    });
    generateChat.mockResolvedValueOnce(CALL_LIST_DOCUMENTS).mockResolvedValueOnce(FINAL);
    const events = await runStream();

    const obs = events.find((e) => e.type === 'observation');
    expect(obs.text).not.toContain('{"id"');
    expect(obs.text).toContain('2');
    expect(obs.text).toContain('Brand book');
    expect(obs.text).toContain('Price list');
  });
});

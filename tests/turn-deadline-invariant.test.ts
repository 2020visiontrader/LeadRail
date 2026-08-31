// Fix 2 (see the task spec this shipped under). PRODUCTION EVIDENCE: a real
// turn died at durationMs 300005 — five milliseconds past
// app/api/agent/stream/route.ts's `maxDuration = 300` — because
// lib/agent/loop.ts's TURN_DEADLINE_MS used to equal the SAME 300 seconds,
// so the platform could kill the route before the in-process deadline ever
// got a chance to fire and hand back a salvaged answer.
//
// This asserts the invariant directly against BOTH real values — not a
// re-implementation of either — so raising one without raising the other
// fails loudly here instead of racing again in production.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// TURN_DEADLINE_MS lives inside lib/agent/loop.ts, a module with a large
// dependency graph (tools, personas, skills, approvals, db, ...). Reusing
// the exact mock set tests/agent-salvage.test.ts and
// tests/agent-deadline-salvage.test.ts already use to import it safely,
// rather than inventing a second one. vi.mock calls are hoisted above
// imports by vitest, so ordering here does not matter.
vi.mock('@/lib/ai/router', () => ({
  generateChat: vi.fn(),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/credits', () => ({ markParseOutcome: vi.fn(), recordAiUsage: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
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

describe('TURN_DEADLINE_MS < maxDuration * 1000', () => {
  it('holds for the real default values in both files', async () => {
    delete process.env.AGENT_TURN_DEADLINE_MS;
    const { TURN_DEADLINE_MS } = await import('@/lib/agent/loop');

    // route.ts is read as source rather than imported: importing a Next.js
    // route handler drags in request/response plumbing this test has no
    // reason to depend on, when the one fact needed — the literal assigned
    // to the exported `maxDuration` — is readable directly and unambiguously
    // from its own source.
    const routeSrc = readFileSync(
      path.join(process.cwd(), 'app/api/agent/stream/route.ts'),
      'utf8',
    );
    const match = routeSrc.match(/export const maxDuration = (\d+)/);
    expect(match).toBeTruthy();
    const maxDuration = Number(match![1]);

    expect(TURN_DEADLINE_MS).toBeLessThan(maxDuration * 1000);
    // Not just "less than" — leaves a real margin (at least 15s) for the
    // salvage path and the SSE response to actually flush before the
    // platform's harder cutoff. A 1ms margin would technically satisfy
    // "less than" while reproducing the same race in practice.
    expect(maxDuration * 1000 - TURN_DEADLINE_MS).toBeGreaterThanOrEqual(15_000);
  });

  it('the default TURN_DEADLINE_MS is exactly 270s', async () => {
    delete process.env.AGENT_TURN_DEADLINE_MS;
    const { TURN_DEADLINE_MS } = await import('@/lib/agent/loop');
    expect(TURN_DEADLINE_MS).toBe(270_000);
  });

  it('AGENT_TURN_DEADLINE_MS env override still works (additive guarantee preserved)', async () => {
    process.env.AGENT_TURN_DEADLINE_MS = '120000';
    try {
      vi.resetModules();
      const { TURN_DEADLINE_MS } = await import('@/lib/agent/loop');
      expect(TURN_DEADLINE_MS).toBe(120_000);
    } finally {
      delete process.env.AGENT_TURN_DEADLINE_MS;
    }
  });
});

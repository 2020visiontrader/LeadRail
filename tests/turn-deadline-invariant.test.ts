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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
// NOT a plain `import` of composeAnswer: this file's `vi.mock('@/lib/agent/compose', ...)`
// above (needed so the loop.ts tests can assert on composeAnswer's call args)
// mocks that module for the WHOLE file, so a normal import here would just
// return the mock's `_a[0]?.draft` stub — exactly the gap this block exists
// to close. vi.importActual bypasses that mock and loads the real module.
// Resolved once, statically, against the SAME generateChat/streamChat vi.fn()s
// the router mock factory above forwards to. compose.ts reads
// AGENT_COMPOSE_STREAM once at module load; it is left unset (its default,
// "enabled") for the whole file, which is what the streaming-branch test
// below relies on.
const { composeAnswer: realComposeAnswer } =
  await vi.importActual<typeof import('@/lib/agent/compose')>('@/lib/agent/compose');

// TURN_DEADLINE_MS lives inside lib/agent/loop.ts, a module with a large
// dependency graph (tools, personas, skills, approvals, db, ...). Reusing
// the exact mock set tests/agent-salvage.test.ts and
// tests/agent-deadline-salvage.test.ts already use to import it safely,
// rather than inventing a second one. vi.mock calls are hoisted above
// imports by vitest, so ordering here does not matter.
const generateChat = vi.fn();
const streamChat = vi.fn();
vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: (...a: any[]) => streamChat(...a),
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
// Captured as vi.fn()s, not plain async stubs, so the two "deadline actually
// threaded" tests below can assert on what they were CALLED WITH — the gap
// this file's original three tests didn't cover: they prove
// TURN_DEADLINE_MS < maxDuration, but nothing proved the value ever reaches
// composeAnswer or the Hermes routing call (see BACKGROUND items a-c on the
// task this shipped under).
const hermesRoute = vi.fn(async (..._a: any[]) => ({ skillIds: ['s0', 's1'] }));
vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: (...a: any[]) => hermesRoute(...a) }));
const composeAnswer = vi.fn(async (..._a: any[]) => (_a[0]?.draft ?? ''));
vi.mock('@/lib/agent/compose', () => ({ composeAnswer: (...a: any[]) => composeAnswer(...a) }));
// 9 enabled skills — one over SKILL_ROUTING_THRESHOLD (8) in lib/agent/loop.ts
// — so selectSkillsForTurn actually calls hermesRoute instead of short-
// circuiting to "inject them all" for a small enabled set.
vi.mock('@/lib/skills/store', () => ({
  loadEnabledSkillsForAgent: async () => Array.from({ length: 9 }, (_, i) => ({
    slug: `skill-${i}`, name: `Skill ${i}`, instructions: `Guidance ${i}`,
  })),
}));
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

// Every route that hands a request to runAgent/runAgentStream must declare a
// maxDuration ABOVE the turn budget — see the invariant above. Scans by
// source, same technique as the test above, so a NEW route wired to the loop
// without maxDuration fails here instead of shipping a third instance of the
// 300004/300005ms production incident.
describe('every runAgent/runAgentStream route declares maxDuration above the turn budget', () => {
  it('app/api/agent/route.ts and app/api/agent/stream/route.ts both qualify', async () => {
    delete process.env.AGENT_TURN_DEADLINE_MS;
    const { TURN_DEADLINE_MS } = await import('@/lib/agent/loop');

    for (const rel of ['app/api/agent/route.ts', 'app/api/agent/stream/route.ts']) {
      const src = readFileSync(path.join(process.cwd(), rel), 'utf8');
      // Anchored to a real line start (`m` flag) so a commented-out
      // declaration (`// export const maxDuration = ...`) does not still
      // satisfy this via a bare substring match.
      const match = src.match(/^export const maxDuration = (\d+)/m);
      expect(match, `${rel} must declare export const maxDuration`).toBeTruthy();
      const maxDuration = Number(match![1]);
      expect(maxDuration * 1000, `${rel}'s maxDuration must exceed TURN_DEADLINE_MS`)
        .toBeGreaterThan(TURN_DEADLINE_MS);
    }
  });
});

// THE WIRING ITSELF, not just the two constants' relationship: a test that
// composeAnswer/hermesRoute are called at all proves nothing about whether
// the deadline argument survived the trip. These assert on the actual call
// arguments captured by the vi.fn()s above.
describe('the turn deadline actually reaches composeAnswer and Hermes routing', () => {
  let toolSeq = 0;
  const FINAL = JSON.stringify({ action: 'final', message: 'Here is what I found.' });

  beforeEach(() => {
    vi.resetModules();
    generateChat.mockReset();
    hermesRoute.mockClear();
    composeAnswer.mockClear();
    toolSeq = 0;
    delete process.env.AGENT_TURN_DEADLINE_MS;
  });

  it('composeAnswer is called with this turn\'s deadlineAt', async () => {
    generateChat.mockResolvedValue(FINAL);
    const { runAgent } = await import('@/lib/agent/loop');
    const before = Date.now();
    const res = await runAgent({ accountId: 'acct-1', message: 'find me some leads' });
    expect(res.status).toBe('done');

    expect(composeAnswer).toHaveBeenCalled();
    const deadlineAt = composeAnswer.mock.calls[0][0]?.deadlineAt;
    expect(typeof deadlineAt).toBe('number');
    // A real turn deadline, not zero/undefined-coerced-to-NaN or a stray
    // constant — it must sit roughly TURN_DEADLINE_MS ahead of "now".
    expect(deadlineAt).toBeGreaterThan(before);
    expect(deadlineAt).toBeLessThanOrEqual(before + 300_000);
  });

  it('the Hermes routing call is called with this turn\'s deadlineAt and accountId', async () => {
    generateChat.mockResolvedValue(FINAL);
    const { runAgent } = await import('@/lib/agent/loop');
    const before = Date.now();
    const res = await runAgent({ accountId: 'acct-1', message: 'find me some leads' });
    expect(res.status).toBe('done');

    expect(hermesRoute).toHaveBeenCalled();
    const ctx = hermesRoute.mock.calls[0][1];
    expect(ctx?.accountId).toBe('acct-1');
    expect(typeof ctx?.deadlineAt).toBe('number');
    expect(ctx.deadlineAt).toBeGreaterThan(before);
    expect(ctx.deadlineAt).toBeLessThanOrEqual(before + 300_000);
  });
});

// THE OTHER HALF OF THE TRIP: the test above proves loop.ts hands deadlineAt
// to composeAnswer, but composeAnswer itself is mocked there, so nothing
// proves compose.ts actually forwards it onto the router call. This block
// imports the REAL composeAnswer from lib/agent/compose and mocks only
// @/lib/ai/router underneath it, so a dropped `deadlineAt: input.deadlineAt,`
// line in compose.ts's callOpts is caught here even though the whole rest of
// the suite (including the block above) stays green.
//
// Both branches of compose.ts's onDelta/AGENT_COMPOSE_STREAM gate are
// covered: composeAnswer calls streamChat when an onDelta callback is passed
// and AGENT_COMPOSE_STREAM !== '0', and generateChat otherwise. A test that
// only exercises one branch leaves the other free to drop the value.
describe('composeAnswer forwards deadlineAt to the router call (both branches)', () => {
  beforeEach(() => {
    generateChat.mockReset();
    streamChat.mockReset();
  });

  it('generateChat branch (no onDelta): callOpts carries this call\'s deadlineAt', async () => {
    generateChat.mockResolvedValue('the final answer');

    const deadlineAt = Date.now() + 42_000;
    const result = await realComposeAnswer({
      accountId: 'acct-1',
      draft: 'draft text',
      transcript: [],
      deadlineAt,
    });

    expect(result).toBe('the final answer');
    expect(streamChat).not.toHaveBeenCalled();
    expect(generateChat).toHaveBeenCalledTimes(1);
    expect(generateChat.mock.calls[0][0]?.deadlineAt).toBe(deadlineAt);
  });

  it('streamChat branch (onDelta + AGENT_COMPOSE_STREAM enabled): callOpts carries this call\'s deadlineAt', async () => {
    streamChat.mockResolvedValue('the streamed answer');

    const deadlineAt = Date.now() + 99_000;
    const result = await realComposeAnswer(
      {
        accountId: 'acct-1',
        draft: 'draft text',
        transcript: [],
        deadlineAt,
      },
      () => {},
    );

    expect(result).toBe('the streamed answer');
    expect(generateChat).not.toHaveBeenCalled();
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(streamChat.mock.calls[0][0]?.deadlineAt).toBe(deadlineAt);
  });
});

// askSpecialist hands the PARENT turn's grounding down to the sub-run.
//
// THE DEFECT THIS COVERS. askSpecialist used to call runAgent with only
// accountId, message, personaId, maxSteps, isDelegate, deadlineAt — no
// agentContext, no brandContext. A specialist was asked to advise while
// knowing nothing about which venture it was advising on or what the
// account already holds, and the parent had to re-explain the answer it
// got back. Fixed by threading ctx.agentContext / ctx.brandContext (already
// built once by the parent turn's loadAgentContext) straight into the
// sub-run, never rebuilt.
//
// THE RATIONING REGRESSION THIS PINS. CLAUDE.md records TWO shipped bugs
// from rationing a delegate's context budget across the team size — a
// `/ delegateCount` division, then a `0.25` share. "Three delegates get what
// one delegate gets" is a standing rule, not a preference: the same
// ctx.agentContext string a lone delegate would receive must reach every
// delegate in a 3-way fan-out, unchanged. That is the specific regression
// pinned below (see "is NOT reduced when there are 2 or 3 delegates").

import { describe, it, expect, vi, beforeEach } from 'vitest';

const runAgent = vi.fn();

vi.mock('@/lib/agent/loop', () => ({ runAgent: (...a: any[]) => runAgent(...a) }));
vi.mock('@/lib/agent/personas', () => ({
  listPersonas: async () => [
    { id: 'p-1', name: 'Nia', role: 'analytics-analyst', enabled: true, is_coordinator: false },
    { id: 'p-2', name: 'Milo', role: 'media-buyer', enabled: true, is_coordinator: false },
    { id: 'p-3', name: 'Ada', role: 'copywriter', enabled: true, is_coordinator: false },
  ],
}));

const FINAL = { status: 'done', message: 'Sub-agent answer.', steps: [] };

// Imported ONCE per test (in beforeEach, after vi.resetModules()) rather than
// re-imported inside every askSpecialist() call: several tests below fire
// concurrent askSpecialist calls via Promise.all, and re-issuing
// `await import(...)` from inside each concurrent call raced the mock
// registration for '@/lib/agent/loop' in this Vitest version — some of the
// concurrent calls resolved the REAL loop.ts instead of the mocked one.
// Resolving the module graph once, before any concurrency starts, sidesteps
// that race entirely.
let askSpecialistCap: any;

async function askSpecialist(args: any, ctx?: any) {
  return askSpecialistCap.run('acct-1', args, ctx);
}

// A realistic-sized grounding block — big enough that a truncated or
// fractional version would visibly differ in length from the original.
const GROUNDING = 'VENTURE GROUNDING BLOCK\n' + 'This account runs three ventures: Rentahub, FilmOps, RetentionRail. '.repeat(80);
const BRAND = { name: 'Rentahub', id: 'brand-rentahub' };

beforeEach(async () => {
  vi.resetModules();
  runAgent.mockReset();
  runAgent.mockResolvedValue(FINAL);
  // Warm the mocked '@/lib/agent/loop' module graph BEFORE any concurrent
  // askSpecialist calls fire — see the comment on askSpecialistCap above.
  await import('@/lib/agent/loop');
  const { DELEGATION_CAPABILITIES } = await import('@/lib/capabilities/delegation');
  askSpecialistCap = DELEGATION_CAPABILITIES.find((c) => c.name === 'askSpecialist');
  if (!askSpecialistCap) throw new Error('askSpecialist capability not registered');
});

describe('askSpecialist grounding passthrough', () => {
  it('carries a non-empty agentContext and brandContext into the sub-run', async () => {
    await askSpecialist(
      { personaId: 'p-1', question: 'what does this spend spike mean?' },
      { deadlineAt: Date.now() + 12_000, agentContext: GROUNDING, brandContext: BRAND },
    );

    expect(runAgent).toHaveBeenCalledTimes(1);
    const call = runAgent.mock.calls[0][0];
    expect(call.agentContext).toBe(GROUNDING);
    expect(call.agentContext.length).toBeGreaterThan(0);
    expect(call.brandContext).toEqual(BRAND);
  });

  it('carries it on the brief-only path too, where there is no persona', async () => {
    await askSpecialist(
      { question: 'summarize these rows', brief: 'You are checking row counts.' },
      { agentContext: GROUNDING, brandContext: BRAND },
    );
    const call = runAgent.mock.calls[0][0];
    expect(call.agentContext).toBe(GROUNDING);
    expect(call.brandContext).toEqual(BRAND);
  });

  it('is NOT reduced when there are 2 or 3 delegates instead of 1 — the pinned regression', async () => {
    // One delegate, consulted alone.
    await askSpecialist({ personaId: 'p-1', question: 'q1' }, { agentContext: GROUNDING, brandContext: BRAND });
    const soloContext = runAgent.mock.calls[0][0].agentContext;

    runAgent.mockClear();

    // The same turn goes on to consult three delegates (the shape a 3-way
    // fan-out step produces via the `calls` batch path — see the
    // "runs multiple delegates concurrently" block below for the batch path
    // itself). Called one after another here, not concurrently: this
    // assertion is about WHAT EACH CALL RECEIVES, not about timing, and
    // askSpecialist has no notion of "how many siblings are running" to key
    // a reduction off in the first place — it reads the same ctx.agentContext
    // on every call regardless of order.
    await askSpecialist({ personaId: 'p-1', question: 'q1' }, { agentContext: GROUNDING, brandContext: BRAND });
    await askSpecialist({ personaId: 'p-2', question: 'q2' }, { agentContext: GROUNDING, brandContext: BRAND });
    await askSpecialist({ personaId: 'p-3', question: 'q3' }, { agentContext: GROUNDING, brandContext: BRAND });

    expect(runAgent).toHaveBeenCalledTimes(3);
    for (const call of runAgent.mock.calls) {
      // Same exact string a lone delegate got — not divided by 3, not a
      // 0.25 share, not truncated because siblings exist.
      expect(call[0].agentContext).toBe(soloContext);
      expect(call[0].agentContext.length).toBe(soloContext.length);
    }
  });

  it('degrades to nothing extra when the caller has no grounding to give', async () => {
    await askSpecialist({ personaId: 'p-1', question: 'a question' });
    const call = runAgent.mock.calls[0][0];
    expect(call.agentContext).toBeUndefined();
    expect(call.brandContext).toBeUndefined();
  });

  it('never sends the sub-run to a different account, grounding or not', async () => {
    await askSpecialist(
      { personaId: 'p-1', question: 'a question' },
      { agentContext: GROUNDING, brandContext: BRAND },
    );
    expect(runAgent.mock.calls[0][0].accountId).toBe('acct-1');
  });
});

describe('askSpecialist still cannot execute an approval', () => {
  it('surfaces a needs_approval sub-run result as text, never runs it', async () => {
    runAgent.mockResolvedValue({ status: 'needs_approval', message: 'Pause this campaign.', tool: 'setCampaignStatus' });
    const result: any = await askSpecialist(
      { personaId: 'p-1', question: 'should we pause this campaign?' },
      { agentContext: GROUNDING, brandContext: BRAND },
    );
    expect(result.recommendsAction).toBe(true);
    expect(result.answer).toContain('Pause this campaign.');
    // Still spawned with isDelegate:true — the sub-run itself is blocked from
    // raising or executing its own approval.
    expect(runAgent.mock.calls[0][0].isDelegate).toBe(true);
  });
});

// HOW MULTIPLE askSpecialist CALLS IN ONE STEP ACTUALLY RUN.
//
// Established by reading the loop before changing anything (per the task):
// a model step can carry EITHER a `reads` array (many DIFFERENT tools in one
// step, lib/agent/reads.ts) OR a `calls` array (the SAME tool over many
// argument sets, lib/agent/batch.ts). `reads` explicitly forbids the same
// tool appearing twice (parseReads' "dupe" check) — so three askSpecialist
// calls in one step can ONLY be expressed as `calls`, which the loop already
// executes via runBatch(), a worker-pool of `min(BATCH_CONCURRENCY, n)` lanes
// running concurrently (lib/agent/batch.ts, Promise.all over the lanes). This
// was true before this change and is UNCHANGED by it — askSpecialist was
// already dispatched through the same runBatch every other tool uses when
// batched, so a 3-delegate step was already concurrent, not serial.
//
// This exercises runBatch itself with askSpecialist-shaped work (a per-call
// delay standing in for the ~90s wall-clock a real specialist can take) to
// pin that the dispatch mechanism is concurrent — proof independent of the
// mocked-dynamic-import fragility the other tests route around above.
describe('askSpecialist is dispatched through the concurrent batch path when there are several', () => {
  it('overlaps in time rather than running one after another', async () => {
    const { runBatch } = await import('@/lib/agent/batch');

    const DELAY_MS = 60;
    const starts: number[] = [];
    const fakeAskSpecialist = async (_args: Record<string, any>) => {
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, DELAY_MS));
      return { ok: true, result: FINAL };
    };

    const t0 = Date.now();
    await runBatch(
      [
        { args: { personaId: 'p-1', question: 'q1' } },
        { args: { personaId: 'p-2', question: 'q2' } },
        { args: { personaId: 'p-3', question: 'q3' } },
      ],
      fakeAskSpecialist,
    );
    const elapsed = Date.now() - t0;

    expect(starts).toHaveLength(3);
    // If these ran serially, elapsed would be >= 3 * DELAY_MS. Concurrent
    // execution keeps it well under 2x a single delegate's delay.
    expect(elapsed).toBeLessThan(DELAY_MS * 2);
    // All three started within one delegate's own delay window of each other.
    const spread = Math.max(...starts) - Math.min(...starts);
    expect(spread).toBeLessThan(DELAY_MS);
  });
});

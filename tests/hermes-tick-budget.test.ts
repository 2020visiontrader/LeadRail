// HOLE 1 (turn-ceiling audit, commit 885f102's follow-up): app/api/hermes/
// tick/route.ts drains six engines with no ceiling of its own and no shared
// budget — one slow engine (runDueScheduledTasks, up to 25 sequential full
// agent turns) could consume the whole tick and starve every engine after
// it. This exercises the fix: engines run one at a time against a shared
// deadline, and once that deadline is spent, no NEW engine is started —
// nothing already running is interrupted.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const processDueJobs = vi.fn(async (..._a: any[]) => ({ processed: 0 }));
const processDueEnrollments = vi.fn(async (..._a: any[]) => ({ processed: 0 }));
const processEnrichmentJobs = vi.fn(async (..._a: any[]) => ({ processed: 0 }));
const processDueWebhookDeliveries = vi.fn(async (..._a: any[]) => ({ processed: 0 }));
const runDueScheduledTasks = vi.fn(async (..._a: any[]) => ({ processed: 0, results: [] as any[], skipped: [] as string[] }));
const runMemoryExtraction = vi.fn(async (..._a: any[]) => ({ processed: 0 }));
const runPlanTick = vi.fn(async (..._a: any[]) => ({ ticked: 0 }));
const purgeDueAccounts = vi.fn(async (..._a: any[]) => [] as string[]);
const maturateRewards = vi.fn(async (..._a: any[]) => 0);

vi.mock('@/lib/hermes/agent', () => ({ processDueJobs: (...a: any[]) => processDueJobs(...a) }));
vi.mock('@/lib/sequences', () => ({ processDueEnrollments: (...a: any[]) => processDueEnrollments(...a) }));
vi.mock('@/lib/enrichment-jobs', () => ({ processEnrichmentJobs: (...a: any[]) => processEnrichmentJobs(...a) }));
vi.mock('@/lib/webhooks-out', () => ({ processDueWebhookDeliveries: (...a: any[]) => processDueWebhookDeliveries(...a) }));
vi.mock('@/lib/scheduled/store', () => ({ runDueScheduledTasks: (...a: any[]) => runDueScheduledTasks(...a) }));
vi.mock('@/lib/memory/extract', () => ({ runMemoryExtraction: (...a: any[]) => runMemoryExtraction(...a) }));
vi.mock('@/lib/plans/runner', () => ({ runPlanTick: (...a: any[]) => runPlanTick(...a) }));
vi.mock('@/lib/privacy', () => ({ purgeDueAccounts: (...a: any[]) => purgeDueAccounts(...a) }));
vi.mock('@/lib/referrals', () => ({ maturateRewards: (...a: any[]) => maturateRewards(...a) }));
vi.mock('@/lib/db', () => ({
  supabase: {
    rpc: async () => ({ data: 0, error: null }),
    from: () => ({ delete: () => ({ lt: () => ({ then: (resolve: any) => resolve({ data: null, error: null }) }) }) }),
  },
  dbReady: () => false,
}));
function makeRequest() {
  return new NextRequest('http://localhost/api/hermes/tick', { method: 'POST' });
}

beforeEach(() => {
  vi.resetModules();
  for (const fn of [
    processDueJobs, processDueEnrollments, processEnrichmentJobs, processDueWebhookDeliveries,
    runDueScheduledTasks, runMemoryExtraction, runPlanTick, purgeDueAccounts, maturateRewards,
  ]) fn.mockClear();
  delete process.env.APP_API_SECRET;
  delete process.env.HERMES_TICK_TIME_BUDGET_MS;
});

describe('app/api/hermes/tick/route.ts declares a ceiling above its own time budget', () => {
  it('maxDuration leaves margin for one already-started engine\'s worst-case agent turn', async () => {
    const { maxDuration } = await import('@/app/api/hermes/tick/route');
    // Imported from the SAME lib/hermes/tick-budget.ts module the route
    // itself imports — not a duplicated literal, so a change to the real
    // value the route uses is exactly what would move this assertion.
    const { TICK_TIME_BUDGET_MS } = await import('@/lib/hermes/tick-budget');
    expect(typeof maxDuration).toBe('number');
    expect(typeof TICK_TIME_BUDGET_MS).toBe('number');
    expect(maxDuration).toBeGreaterThan(0);
    // Same discipline as tests/turn-deadline-invariant.test.ts: not just
    // "greater than", but a real margin — the budget stops NEW engine work,
    // it does not interrupt an engine already mid-turn, so the ceiling must
    // cover budget + one full agent turn (TURN_DEADLINE_MS, 270s) + slack.
    const { TURN_DEADLINE_MS } = await import('@/lib/agent/loop');
    expect(maxDuration * 1000 - TICK_TIME_BUDGET_MS).toBeGreaterThanOrEqual(TURN_DEADLINE_MS + 15_000);
  });

  it('declares runtime = nodejs', async () => {
    const { runtime } = await import('@/app/api/hermes/tick/route');
    expect(runtime).toBe('nodejs');
  });
});

describe('the tick stops starting new engine work once its shared budget is spent', () => {
  it('REVERT-CHECK TARGET: an engine that runs past the budget causes every later engine to be skipped, not run', async () => {
    process.env.HERMES_TICK_TIME_BUDGET_MS = '5';
    // The first engine invoked (legacy/processDueJobs) takes longer than the
    // 5ms budget, so by the time the loop reaches the second engine the
    // budget is already spent.
    processDueJobs.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { processed: 1 };
    });

    const { POST } = await import('@/app/api/hermes/tick/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    // The first engine actually ran.
    expect(processDueJobs).toHaveBeenCalledTimes(1);
    expect(body.legacy).toEqual({ processed: 1 });

    // Every engine after it was never even called — not run with a spent
    // budget, not run and then discarded — genuinely never invoked.
    expect(processDueEnrollments).not.toHaveBeenCalled();
    expect(processEnrichmentJobs).not.toHaveBeenCalled();
    expect(processDueWebhookDeliveries).not.toHaveBeenCalled();
    expect(runDueScheduledTasks).not.toHaveBeenCalled();
    expect(runMemoryExtraction).not.toHaveBeenCalled();
    expect(runPlanTick).not.toHaveBeenCalled();

    // Skipped engines are reported honestly in the response, not dropped.
    expect(body.sequences).toMatchObject({ skipped: true });
    expect(body.plans).toMatchObject({ skipped: true });
  });

  it('with a generous budget, every engine still runs (no false-positive skip)', async () => {
    process.env.HERMES_TICK_TIME_BUDGET_MS = String(5 * 60 * 1000);
    const { POST } = await import('@/app/api/hermes/tick/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(processDueJobs).toHaveBeenCalledTimes(1);
    expect(processDueEnrollments).toHaveBeenCalledTimes(1);
    expect(processEnrichmentJobs).toHaveBeenCalledTimes(1);
    expect(processDueWebhookDeliveries).toHaveBeenCalledTimes(1);
    expect(runDueScheduledTasks).toHaveBeenCalledTimes(1);
    expect(runMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(runPlanTick).toHaveBeenCalledTimes(1);
    expect(body.plans).not.toMatchObject({ skipped: true });
  });

  it('threads a deadline into runDueScheduledTasks capped to its OWN sub-budget, not the full tick deadline', async () => {
    process.env.HERMES_TICK_TIME_BUDGET_MS = String(5 * 60 * 1000);
    const { POST } = await import('@/app/api/hermes/tick/route');
    const { SCHEDULED_TASKS_SUB_BUDGET_MS } = await import('@/lib/hermes/tick-budget');
    const before = Date.now();
    await POST(makeRequest());
    expect(runDueScheduledTasks).toHaveBeenCalledTimes(1);
    const deadlineArg = runDueScheduledTasks.mock.calls[0][0];
    expect(typeof deadlineArg).toBe('number');
    expect(deadlineArg).toBeGreaterThan(before);
    // The real assertion: bounded by the SUB-budget (half the tick budget),
    // not the full 5-minute tick deadline — proves this engine's cap is
    // independent of the (generous) overall budget, not just "less than it".
    expect(deadlineArg).toBeLessThanOrEqual(before + SCHEDULED_TASKS_SUB_BUDGET_MS + 5_000);
  });
});

describe('no engine can be permanently starved by its position in the run order', () => {
  it('REVERT-CHECK TARGET: runDueScheduledTasks consuming its entire allotment does not prevent runPlanTick or runMemoryExtraction from starting on the SAME tick', async () => {
    // A tight overall budget, deliberately: this has to be small enough that
    // scheduledTasks' delay below (a stand-in for real minutes-long agent
    // turns) COULD exhaust it — otherwise this test would pass regardless of
    // engine order just because the budget was never actually threatened,
    // proving nothing about ordering. The delay is well over double the
    // budget specifically so a mis-ordered engine has more than enough room
    // to blow through it before plans/memory would get their turn.
    process.env.HERMES_TICK_TIME_BUDGET_MS = '100';
    // Simulates the exact production shape this regression would reintroduce:
    // an account with a scheduled-task backlog that alone could burn through
    // an entire tick's budget.
    runDueScheduledTasks.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 250));
      return { processed: 25, results: [], skipped: [] };
    });

    const { POST } = await import('@/app/api/hermes/tick/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    // The critical assertion: plans and memory ran on THIS tick, even though
    // the scheduled-task engine (the one capable of eating the whole budget)
    // also ran on it. Before the ordering fix, scheduledTasks ran ahead of
    // both and its 60ms (a stand-in for real minutes-long agent turns) would
    // have exhausted a tight budget before either got a chance to start.
    expect(runPlanTick).toHaveBeenCalledTimes(1);
    expect(runMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(runDueScheduledTasks).toHaveBeenCalledTimes(1);
    expect(body.plans).not.toMatchObject({ skipped: true });
    expect(body.memory).not.toMatchObject({ skipped: true });
  });
});

// HOLE 2 (turn-ceiling audit): lib/pipeline/store.ts's runPipeline ran six
// sequential runAgent turns, each getting its OWN fresh TURN_DEADLINE_MS
// (270s) budget — nothing bounded the run overall (~6 x 270s worst case).
// This exercises the fix: ONE deadline computed once for the whole run,
// shared (not recomputed) across every stage's runAgent call, and unrun
// stages reported honestly rather than dropped when the budget runs out.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let runs: any[] = [];
const runAgent = vi.fn(async (..._a: any[]) => ({ status: 'done', message: 'APPROVED — looks good.', transcript: [] as any[] }));

vi.mock('@/lib/agent/loop', () => ({ runAgent: (...a: any[]) => runAgent(...a) }));
vi.mock('@/lib/agent/context', () => ({ loadAgentContext: async () => 'GROUNDING' }));
vi.mock('@/lib/db', () => ({
  supabase: {
    from(table: string) {
      if (table === 'brands') {
        return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: null }) } as any;
      }
      const q: any = {
        _f: [] as ((r: any) => boolean)[],
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
        insert(rows: any[]) {
          const row = { id: `run-${runs.length + 1}`, account_id: rows[0].account_id, brand_id: null, topic: rows[0].topic, status: rows[0].status, current_stage: rows[0].current_stage, stages: rows[0].stages, output: rows[0].output, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          runs.push(row);
          return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
        },
        update(patch: any) {
          const matches = () => runs.filter((r) => q._f.every((f: any) => f(r)));
          return {
            eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return this; },
            then: async (resolve: any) => {
              for (const r of matches()) Object.assign(r, patch);
              return resolve({ data: matches(), error: null });
            },
          };
        },
        maybeSingle: async () => ({ data: runs.filter((r) => q._f.every((f: any) => f(r)))[0] ?? null, error: null }),
      };
      return q;
    },
  },
}));

beforeEach(() => {
  vi.resetModules();
  runs = [];
  runAgent.mockReset();
  runAgent.mockImplementation(async () => ({ status: 'done', message: 'APPROVED — looks good.', transcript: [] }));
  delete process.env.CONTENT_PIPELINE_BUDGET_MS;
});

describe('runPipeline shares ONE deadline across every stage instead of a fresh one each', () => {
  it('REVERT-CHECK TARGET: every stage\'s runAgent call receives the SAME deadlineAt', async () => {
    const { runPipeline } = await import('@/lib/pipeline/store');
    const run = await runPipeline('acct-1', 'topic');
    expect(run.status).toBe('completed');
    expect(runAgent).toHaveBeenCalledTimes(6);

    const deadlines = runAgent.mock.calls.map((c) => c[0]?.deadlineAt);
    expect(deadlines.every((d) => typeof d === 'number')).toBe(true);
    // Every call must share the exact same value — a later stage getting a
    // FRESH, larger deadlineAt than an earlier one is exactly the bug this
    // guards against (each stage silently getting its own new full budget
    // again instead of what's left of the run's one shared budget).
    const distinct = new Set(deadlines);
    expect(distinct.size).toBe(1);
  });

  it('the shared deadline is roughly PIPELINE_TOTAL_BUDGET_MS ahead of when the run started', async () => {
    const { runPipeline, PIPELINE_TOTAL_BUDGET_MS } = await import('@/lib/pipeline/store');
    const before = Date.now();
    await runPipeline('acct-1', 'topic');
    const deadlineAt = runAgent.mock.calls[0][0]?.deadlineAt;
    expect(deadlineAt).toBeGreaterThanOrEqual(before + PIPELINE_TOTAL_BUDGET_MS - 1000);
    expect(deadlineAt).toBeLessThanOrEqual(before + PIPELINE_TOTAL_BUDGET_MS + 5000);
  });
});

describe('runPipeline reports stages it could not run rather than dropping them', () => {
  it('stops starting new stages once the shared budget is spent, and marks the rest failed with a reason', async () => {
    process.env.CONTENT_PIPELINE_BUDGET_MS = '10';
    // Each call takes longer than the 10ms budget, so by the time the loop
    // re-checks before stage 2 the deadline has already passed.
    runAgent.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { status: 'done', message: 'APPROVED', transcript: [] };
    });

    const { runPipeline } = await import('@/lib/pipeline/store');
    const run = await runPipeline('acct-1', 'topic');

    expect(run.status).toBe('failed');
    // First stage actually ran (started before the budget was spent).
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(run.stages[0].status).toBe('done');

    // Every remaining stage is reported as failed/not-run, not silently
    // missing from `stages` and not reported as if it succeeded.
    for (let i = 1; i < run.stages.length; i++) {
      expect(run.stages[i].status).toBe('failed');
      expect(run.stages[i].error).toMatch(/not run/i);
    }
    expect(run.output.unrunStages).toEqual(['planner', 'creator', 'reviewer', 'publisher', 'analyst']);
  });

  it('with a generous budget, all six stages run and none are reported unrun', async () => {
    const { runPipeline } = await import('@/lib/pipeline/store');
    const run = await runPipeline('acct-1', 'topic');
    expect(run.status).toBe('completed');
    expect(run.stages.every((s: any) => s.status === 'done')).toBe(true);
  });
});

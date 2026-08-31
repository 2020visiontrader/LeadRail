// Batch plan steps (migration 079) — the store-level primitives the runner
// builds on: creation with `over`, and the atomic cursor advance.
//
// The property that matters: no item is ever processed twice, none is
// skipped, and the `over` cap is refused at creation, not discovered later.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let plans: any[] = [];
let steps: any[] = [];
let idSeq = 0;

/** Fake client whose `rpc('advance_plan_step_cursor', ...)` mirrors the real
 *  function's semantics from migration 079: a single conditional update, only
 *  against a row still `in_progress`, resetting attempts to 0 on success. */
function makeClient() {
  return {
    rpc: async (fn: string, params: any) => {
      if (fn !== 'advance_plan_step_cursor') return { data: null, error: null };
      const row = steps.find((s) => s.id === params.p_step_id);
      if (!row || row.status !== 'in_progress') return { data: [], error: null };
      const by = Math.max(0, Math.floor(params.p_by) || 0);
      const raw = row.cursor + by;
      const newCursor = row.total != null ? Math.min(raw, row.total) : raw;
      row.cursor = newCursor;
      row.attempts = 0;
      const done = row.total != null && newCursor >= row.total;
      if (!done) row.status = 'pending';
      row.updated_at = new Date().toISOString();
      return { data: [{ new_cursor: newCursor, step_total: row.total }], error: null };
    },
    from(table: string) {
      const rows = () => (table === 'agent_plans' ? plans : steps);
      const q: any = {
        _f: [] as ((r: any) => boolean)[], _mode: 'select', _patch: null as any,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
        in(c: string, v: any[]) { q._f.push((r: any) => v.includes(r[c])); return q; },
        order() { return q; },
        limit() { return q; },
        single: async () => ({ data: rows()[rows().length - 1] ?? null, error: null }),
        maybeSingle: async () => ({ data: rows().filter((r) => q._f.every((f: any) => f(r)))[0] ?? null, error: null }),
        update(p: any) { q._mode = 'update'; q._patch = p; return q; },
        insert(input: any[]) {
          const created = input.map((r) => ({ id: `id-${++idSeq}`, created_at: Date.now(), ...r }));
          rows().push(...created);
          const res = { data: created, error: null };
          return { select: () => Object.assign(Promise.resolve(res), { single: async () => ({ data: created[0], error: null }) }) };
        },
        delete() { q._mode = 'delete'; return q; },
        then(resolve: any) {
          const matched = rows().filter((r) => q._f.every((f: any) => f(r)));
          if (q._mode === 'update') {
            for (const r of matched) Object.assign(r, q._patch);
            return resolve({ data: matched.map((r) => ({ id: r.id, attempts: r.attempts })), error: null });
          }
          if (q._mode === 'delete') {
            for (const r of matched) rows().splice(rows().indexOf(r), 1);
            return resolve({ data: matched, error: null });
          }
          return resolve({ data: matched, error: null });
        },
      };
      return q;
    },
  };
}

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() } }));

async function mod() { return import('@/lib/plans/store'); }

beforeEach(() => {
  vi.resetModules();
  plans = []; steps = []; idSeq = 0;
});

describe('createPlan with a batch step', () => {
  it('records `total` from `over`\'s length at creation', async () => {
    const { createPlan } = await mod();
    const plan = await createPlan({
      accountId: 'acct-1', objective: 'Work the leads',
      steps: [{ title: 'Handle every lead', over: ['l1', 'l2', 'l3'] }, 'Report back'],
    });
    expect(plan).toBeTruthy();
    const batch = plan!.steps.find((s) => s.title === 'Handle every lead')!;
    expect(batch.total).toBe(3);
    expect(batch.cursor).toBe(0);
    expect(batch.over).toEqual(['l1', 'l2', 'l3']);
    const ordinary = plan!.steps.find((s) => s.title === 'Report back')!;
    expect(ordinary.total).toBeNull();
    expect(ordinary.over).toBeNull();
  });

  it('REVERT-CHECK TARGET: refuses a plan whose over list exceeds the cap, at creation', async () => {
    const { createPlan, MAX_STEP_OVER_ITEMS } = await mod();
    const tooMany = Array.from({ length: MAX_STEP_OVER_ITEMS + 1 }, (_, i) => `item-${i}`);
    const plan = await createPlan({
      accountId: 'acct-1', objective: 'Too big',
      steps: [{ title: 'Handle everything', over: tooMany }, 'Report'],
    });
    expect(plan).toBeNull();
    expect(steps.length).toBe(0); // nothing was written — refused, not truncated
  });

  it('accepts an over list exactly at the cap', async () => {
    const { createPlan, MAX_STEP_OVER_ITEMS } = await mod();
    const exact = Array.from({ length: MAX_STEP_OVER_ITEMS }, (_, i) => `item-${i}`);
    const plan = await createPlan({
      accountId: 'acct-1', objective: 'Right at the line',
      steps: [{ title: 'Handle everything', over: exact }, 'Report'],
    });
    expect(plan).toBeTruthy();
    expect(plan!.steps.find((s) => s.total != null)!.total).toBe(MAX_STEP_OVER_ITEMS);
  });
});

describe('advanceCursor', () => {
  function seedBatchStep(opts: { cursor?: number; total?: number; status?: string; attempts?: number } = {}) {
    steps = [{
      id: 's1', plan_id: 'p1', seq: 1, title: 'Batch', status: opts.status ?? 'in_progress',
      result: null, attempts: opts.attempts ?? 1, blocked_reason: null, approval_id: null,
      over: ['a', 'b', 'c', 'd', 'e'], cursor: opts.cursor ?? 0, total: opts.total ?? 5,
    }];
  }

  it('advances the cursor and resets attempts to 0 on success', async () => {
    seedBatchStep({ attempts: 2 });
    const { advanceCursor } = await mod();
    const r = await advanceCursor('s1', 3);
    expect(r).toEqual({ cursor: 3, total: 5, done: false });
    expect(steps[0].cursor).toBe(3);
    expect(steps[0].attempts).toBe(0);
    expect(steps[0].status).toBe('pending'); // re-claimable next tick
  });

  it('reports done and leaves status in_progress when the cursor reaches total', async () => {
    seedBatchStep({ cursor: 3 });
    const { advanceCursor } = await mod();
    const r = await advanceCursor('s1', 2);
    expect(r).toEqual({ cursor: 5, total: 5, done: true });
    // Left in_progress on purpose — the caller (runner) transitions to `done`
    // via completeStep immediately after, same as an ordinary step.
    expect(steps[0].status).toBe('in_progress');
  });

  it('REVERT-CHECK TARGET: never advances a step that is not in_progress (the concurrency guard)', async () => {
    seedBatchStep({ status: 'pending' });
    const { advanceCursor } = await mod();
    const r = await advanceCursor('s1', 2);
    expect(r).toBeNull();
    expect(steps[0].cursor).toBe(0); // untouched
  });

  it('two concurrent advances on the same step: exactly one succeeds, cursor advances by exactly one call\'s amount', async () => {
    seedBatchStep();
    const { advanceCursor } = await mod();
    const [a, b] = await Promise.all([advanceCursor('s1', 2), advanceCursor('s1', 2)]);
    const results = [a, b];
    const succeeded = results.filter((r) => r !== null);
    const failed = results.filter((r) => r === null);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    // The item slice was applied exactly once — cursor moved by ONE tick's
    // worth of items, not two, which is what "no item processed twice" means
    // at the cursor level.
    expect(steps[0].cursor).toBe(2);
  });
});

describe('releaseStepForRetry', () => {
  it('returns an in_progress step to pending without touching cursor or attempts', async () => {
    steps = [{
      id: 's1', plan_id: 'p1', seq: 1, title: 'Batch', status: 'in_progress',
      result: null, attempts: 2, blocked_reason: null, approval_id: null,
      over: ['a', 'b', 'c'], cursor: 1, total: 3,
    }];
    const { releaseStepForRetry } = await mod();
    await releaseStepForRetry('s1');
    expect(steps[0].status).toBe('pending');
    expect(steps[0].cursor).toBe(1); // unchanged — no item skipped
    expect(steps[0].attempts).toBe(2); // unchanged — failures still count
  });

  it('REVERT-CHECK TARGET: does nothing to a step that is not in_progress', async () => {
    steps = [{
      id: 's1', plan_id: 'p1', seq: 1, title: 'Batch', status: 'blocked',
      result: null, attempts: 1, blocked_reason: 'waiting', approval_id: 'a1',
      over: ['a'], cursor: 0, total: 1,
    }];
    const { releaseStepForRetry } = await mod();
    await releaseStepForRetry('s1');
    expect(steps[0].status).toBe('blocked'); // untouched
  });
});

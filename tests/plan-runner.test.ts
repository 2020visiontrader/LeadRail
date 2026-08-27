// The runner is what lets a plan outlive one request, and that is exactly what
// makes it the dangerous part: it runs agent turns with nobody watching. These
// assert the bounds, not the happy path.
//
// The three that matter:
//   - a plan cannot exceed its step budget
//   - a step that keeps failing parks itself instead of retrying forever
//   - an approval PARKS a step; it never auto-approves and never fails the plan

import { describe, it, expect, vi, beforeEach } from 'vitest';

let plans: any[] = [];
let steps: any[] = [];
let agentResult: any = { status: 'done', message: 'Did it.', steps: [{}, {}], transcript: [] };
const runAgent = vi.fn(async (_input?: any) => agentResult);

function rowsFor(table: string) { return table === 'agent_plans' ? plans : steps; }

vi.mock('@/lib/db', () => ({
  supabase: {
    from(table: string) {
      const q: any = {
        _f: [] as ((r: any) => boolean)[], _mode: 'select', _patch: null as any,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
        in(c: string, v: any[]) { q._f.push((r: any) => v.includes(r[c])); return q; },
        is(c: string, v: any) { q._f.push((r: any) => (v === null ? r[c] == null : r[c] === v)); return q; },
        gt(c: string, v: any) { q._f.push((r: any) => r[c] > v); return q; },
        gte(c: string, v: any) { q._f.push((r: any) => r[c] >= v); return q; },
        order() { return q; },
        limit() { return q; },
        maybeSingle: async () => ({ data: rowsFor(table).filter((r) => q._f.every((f: any) => f(r)))[0] ?? null, error: null }),
        update(p: any) { q._mode = 'update'; q._patch = p; return q; },
        then(resolve: any) {
          const rows = rowsFor(table).filter((r) => q._f.every((f: any) => f(r)));
          if (q._mode === 'update') {
            for (const r of rows) Object.assign(r, q._patch);
            return resolve({ data: rows.map((r) => ({ id: r.id, plan_id: r.plan_id, attempts: r.attempts })), error: null });
          }
          return resolve({ data: rows, error: null });
        },
      };
      return q;
    },
  },
  dbReady: () => true,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() } }));
vi.mock('@/lib/agent/loop', () => ({ runAgent: (...a: any[]) => runAgent(...(a as [])) }));

function seed(opts: { stepsUsed?: number; maxSteps?: number; attempts?: number; status?: string } = {}) {
  plans = [{
    id: 'p1', account_id: 'acct-1', conversation_id: 'c1', brand_id: null,
    objective: 'Do the thing', status: 'running',
    max_steps: opts.maxSteps ?? 200, steps_used: opts.stepsUsed ?? 0,
    expires_at: new Date(Date.now() + 3600_000).toISOString(), last_error: null,
  }];
  steps = [
    { id: 's1', plan_id: 'p1', seq: 1, title: 'First', status: opts.status ?? 'pending', result: null, attempts: opts.attempts ?? 0, blocked_reason: null, approval_id: null },
    { id: 's2', plan_id: 'p1', seq: 2, title: 'Second', status: 'pending', result: null, attempts: 0, blocked_reason: null, approval_id: null },
  ];
}

async function tick() {
  const { runPlanTick } = await import('@/lib/plans/runner');
  return runPlanTick();
}

describe('advances one step at a time', () => {
  beforeEach(() => {
    vi.resetModules(); runAgent.mockClear();
    agentResult = { status: 'done', message: 'Did it.', steps: [{}, {}], transcript: [] };
    seed();
  });

  it('works exactly ONE step per tick, not the whole plan', async () => {
    const r = await tick();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(r.stepsCompleted).toBe(1);
    expect(steps.find((s) => s.id === 's2')!.status).toBe('pending');
  });

  it('names the single step in the prompt rather than the objective', async () => {
    // The plan block is already in the grounding; restating the objective makes
    // the model re-plan instead of executing.
    await tick();
    const msg = String(runAgent.mock.calls[0]?.[0]?.message ?? '');
    expect(msg).toContain('Step 1: First');
    expect(msg).toContain('s1');
  });

  it('passes the conversation so grants and memory apply to the run', async () => {
    await tick();
    expect(runAgent.mock.calls[0]?.[0]?.conversationId).toBe('c1');
  });

  it('gives a plan step a smaller budget than a full turn', async () => {
    await tick();
    expect(runAgent.mock.calls[0]?.[0]?.maxSteps).toBeLessThan(16);
  });

  it('closes the step even when the model forgot to call completePlanStep', async () => {
    // Leaving it in_progress would stall the plan behind a step nothing
    // advances — the single-active invariant would block every later step.
    await tick();
    expect(steps.find((s) => s.id === 's1')!.status).toBe('done');
  });
});

describe('budgets are ceilings', () => {
  beforeEach(() => { vi.resetModules(); runAgent.mockClear(); });

  it('refuses to run a plan that has spent its budget', async () => {
    seed({ stepsUsed: 200, maxSteps: 200 });
    await tick();
    // Checked BEFORE the work — checking after would allow one more step than
    // was ever permitted.
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('marks an exhausted plan failed rather than leaving it runnable', async () => {
    seed({ stepsUsed: 200, maxSteps: 200 });
    await tick();
    expect(plans[0].status).toBe('failed');
  });

  it('accumulates spend across ticks', async () => {
    seed();
    agentResult = { status: 'done', message: 'ok', steps: [{}, {}, {}], transcript: [] };
    await tick();
    expect(plans[0].steps_used).toBe(3);
  });
});

describe('a failing step parks itself', () => {
  beforeEach(() => { vi.resetModules(); runAgent.mockClear(); });

  it('blocks a step that has used its attempts instead of retrying', async () => {
    seed({ attempts: 3 });
    await tick();
    expect(runAgent).not.toHaveBeenCalled();
    expect(steps.find((s) => s.id === 's1')!.status).toBe('blocked');
  });

  it('does not fail the whole plan for one error', async () => {
    seed();
    agentResult = { status: 'error', message: 'upstream died', steps: [], transcript: [] };
    await tick();
    expect(plans[0].status).not.toBe('failed');
  });
});

describe('an approval parks the step, it never auto-approves', () => {
  beforeEach(() => { vi.resetModules(); runAgent.mockClear(); });

  it('blocks the step and records which approval it waits on', async () => {
    seed();
    agentResult = {
      status: 'needs_approval', message: 'needs you',
      proposal: { approvalId: 'appr-1', summary: 'Spend credits on 50 leads' },
      steps: [{}], transcript: [],
    };
    const r = await tick();
    const s1 = steps.find((s) => s.id === 's1')!;
    expect(r.stepsBlocked).toBe(1);
    expect(s1.status).toBe('blocked');
    // Keyed on the approval so the resume lands on THIS step rather than
    // restarting the plan and redoing paid-for work.
    expect(s1.approval_id).toBe('appr-1');
  });

  it('keeps the plan RUNNING while other steps are still workable', async () => {
    // One step waiting on a human must not stall the rest of the plan. The
    // plan only becomes `blocked` when nothing else can proceed.
    seed();
    agentResult = {
      status: 'needs_approval', message: 'needs you',
      proposal: { approvalId: 'appr-1', summary: 's' }, steps: [{}], transcript: [],
    };
    await tick();
    expect(steps.find((s) => s.id === 's1')!.status).toBe('blocked');
    expect(plans[0].status).toBe('running');   // step 2 is still pending
  });

  it('marks the plan blocked once EVERY remaining step is waiting', async () => {
    seed();
    steps[1].status = 'blocked';               // second step already parked
    agentResult = {
      status: 'needs_approval', message: 'needs you',
      proposal: { approvalId: 'appr-1', summary: 's' }, steps: [{}], transcript: [],
    };
    await tick();
    // Nothing workable left — and blocked, never failed: a human decision
    // outstanding is not an error.
    expect(plans[0].status).toBe('blocked');
  });
});

describe('resuming after approval', () => {
  beforeEach(() => { vi.resetModules(); });

  it('releases the step the approval was blocking', async () => {
    seed();
    steps[0].status = 'blocked';
    steps[0].approval_id = 'appr-1';
    plans[0].status = 'blocked';
    const { resumeStepForApproval } = await import('@/lib/plans/store');
    expect(await resumeStepForApproval('acct-1', 'appr-1')).toBe(true);
    expect(steps[0].status).toBe('pending');
    expect(plans[0].status).toBe('running');
  });

  it('does not reset the attempt count — a step that failed twice still has', async () => {
    seed();
    steps[0].status = 'blocked'; steps[0].approval_id = 'appr-1'; steps[0].attempts = 2;
    const { resumeStepForApproval } = await import('@/lib/plans/store');
    await resumeStepForApproval('acct-1', 'appr-1');
    expect(steps[0].attempts).toBe(2);
  });

  it('is a no-op for an ordinary interactive approval', async () => {
    seed();
    const { resumeStepForApproval } = await import('@/lib/plans/store');
    // The normal case, not an error.
    expect(await resumeStepForApproval('acct-1', 'unrelated')).toBe(false);
  });
});

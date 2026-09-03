// G13 — a plan drafted in plan mode can never start on its own: `createPlan`
// starts it in `draft`, `runnablePlans` only ever selects `status = 'running'`,
// and `approvePlan` (the draft -> running flip) had zero callers anywhere in
// the codebase. This exercises the fix: the `startPlan` capability, wired to
// approvePlan, followed by a real runnablePlans read — against the REAL
// lib/plans/store, not a mock of it, so the assertion is "the plan the
// capability started is the plan the runner will actually pick up next tick",
// not "the mock was called with the right arguments".

import { describe, it, expect, vi, beforeEach } from 'vitest';

let plans: any[] = [];
let steps: any[] = [];
let idSeq = 0;

/** Minimal fake client, same shape tests/plan-store-batch.test.ts already
 *  uses for exercising the real lib/plans/store against agent_plans /
 *  agent_plan_steps. */
function makeClient() {
  return {
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      const rows = () => (table === 'agent_plans' ? plans : steps);
      const q: any = {
        _f: [] as ((r: any) => boolean)[], _mode: 'select', _patch: null as any,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
        in(c: string, v: any[]) { q._f.push((r: any) => v.includes(r[c])); return q; },
        gt(c: string, v: any) { q._f.push((r: any) => r[c] > v); return q; },
        order() { return q; },
        limit(n: number) { q._limit = n; return q; },
        single: async () => ({ data: rows()[rows().length - 1] ?? null, error: null }),
        maybeSingle: async () => ({ data: rows().filter((r) => q._f.every((f: any) => f(r)))[0] ?? null, error: null }),
        update(p: any) { q._mode = 'update'; q._patch = p; return q; },
        then(resolve: any) {
          let matched = rows().filter((r) => q._f.every((f: any) => f(r)));
          if (q._limit != null) matched = matched.slice(0, q._limit);
          if (q._mode === 'update') {
            for (const r of matched) Object.assign(r, q._patch);
            return resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
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

function seedDraft() {
  plans = [{
    id: 'plan-1', account_id: 'acct-1', conversation_id: 'conv-1', brand_id: null,
    objective: 'Enrol 50 leads', status: 'draft', max_steps: 200, steps_used: 0,
    expires_at: new Date(Date.now() + 3600_000).toISOString(), last_error: null,
    skills: [], persona_id: null,
  }];
  steps = [{
    id: 'step-1', plan_id: 'plan-1', seq: 1, title: 'Do it', status: 'pending',
    result: null, attempts: 0, blocked_reason: null, approval_id: null,
    over: null, cursor: 0, total: null,
  }];
}

async function loadCapabilities() {
  const { PLAN_CAPABILITIES } = await import('@/lib/capabilities/plans');
  return PLAN_CAPABILITIES.find((c) => c.name === 'startPlan')!;
}

beforeEach(() => {
  vi.resetModules();
  idSeq = 0;
  seedDraft();
});

describe('startPlan capability — resolving the target plan', () => {
  it('starts the draft plan attached to the current conversation when no planId is given', async () => {
    const startPlan = await loadCapabilities();
    const r = await startPlan.run('acct-1', {}, { conversationId: 'conv-1' });
    expect(r).toEqual({ started: true, planId: 'plan-1' });
    expect(plans[0].status).toBe('running');
  });

  it('starts a plan named explicitly by planId', async () => {
    const startPlan = await loadCapabilities();
    const r = await startPlan.run('acct-1', { planId: 'plan-1' }, {});
    expect(r).toEqual({ started: true, planId: 'plan-1' });
    expect(plans[0].status).toBe('running');
  });

  it('does nothing when the resolved plan is not a draft (e.g. already running)', async () => {
    plans[0].status = 'running';
    const startPlan = await loadCapabilities();
    const r = await startPlan.run('acct-1', {}, { conversationId: 'conv-1' });
    expect(r.started).toBe(false);
    expect(plans[0].status).toBe('running'); // unchanged, not re-flipped
  });

  it('reports nothing to start when the conversation has no plan at all', async () => {
    plans = [];
    const startPlan = await loadCapabilities();
    const r = await startPlan.run('acct-1', {}, { conversationId: 'conv-1' });
    expect(r).toEqual({ started: false, planId: null });
    expect(startPlan.digest!({}, r)).toMatch(/no draft plan/i);
  });
});

describe('startPlan capability — the plan actually becomes runnable', () => {
  it('REVERT-CHECK TARGET: a plan started through the capability is then picked up by runnablePlans, which only ever selects status=running', async () => {
    const { runnablePlans } = await import('@/lib/plans/store');

    // Before starting: draft plans are invisible to the runner.
    expect(await runnablePlans(10)).toHaveLength(0);

    const startPlan = await loadCapabilities();
    const r = await startPlan.run('acct-1', {}, { conversationId: 'conv-1' });
    expect(r.started).toBe(true);

    const runnable = await runnablePlans(10);
    expect(runnable.map((p) => p.id)).toEqual(['plan-1']);
    expect(runnable[0].status).toBe('running');
  });
});

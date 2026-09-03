// tests/plan-list-capability.test.ts
//
// G16d — there was no way to discover what plans exist on an account, so "what
// are you working on" had no answer, and getPlan needed an id nothing could
// produce. listPlans (lib/plans/store.ts) plus its capability
// (lib/capabilities/plans.ts) close that gap. This file checks:
//   1. lib/plans/store.ts's listPlans query shape — active plans plus a
//      capped, recency-sorted terminal tail, scoped to the account
//   2. the capability is registered in CATALOG_ORDER right after getPlan and
//      before startPlan, and reaches the MCP surface like every other one
//      (tests/parity.test.ts is the general guard; this re-checks it locally)
//   3. its digest never reports a count it did not actually see in the result

import { describe, it, expect, vi, beforeEach } from 'vitest';

let plans: any[] = [];
let steps: any[] = [];

/** Minimal fake client, same shape tests/plan-capabilities-start.test.ts and
 *  tests/plan-store-batch.test.ts already use for exercising the real
 *  lib/plans/store against agent_plans / agent_plan_steps. */
function makeClient() {
  return {
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      const rows = () => (table === 'agent_plans' ? plans : steps);
      const q: any = {
        _f: [] as ((r: any) => boolean)[],
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
        in(c: string, v: any[]) { q._f.push((r: any) => v.includes(r[c])); return q; },
        order() { return q; },
        limit(n: number) { q._limit = n; return q; },
        then(resolve: any) {
          let matched = rows().filter((r: any) => q._f.every((f: any) => f(r)));
          // Every real call here orders by created_at desc — the mock applies
          // that unconditionally rather than tracking which column was named,
          // since every query in listPlans uses the same ordering.
          matched = [...matched].sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
          if (q._limit != null) matched = matched.slice(0, q._limit);
          return resolve({ data: matched, error: null });
        },
      };
      return q;
    },
  };
}

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() } }));

function seedPlans() {
  plans = [
    { id: 'p-running', account_id: 'acct-1', conversation_id: 'c1', objective: 'Running one', status: 'running', created_at: '2026-09-01T00:00:00Z' },
    { id: 'p-blocked', account_id: 'acct-1', conversation_id: null, objective: 'Blocked one', status: 'blocked', created_at: '2026-08-30T00:00:00Z' },
    { id: 'p-draft', account_id: 'acct-1', conversation_id: null, objective: 'Draft one', status: 'draft', created_at: '2026-08-29T00:00:00Z' },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `p-done-${i}`, account_id: 'acct-1', conversation_id: null,
      objective: `Done ${i}`, status: 'done',
      created_at: `2026-08-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
    })),
    { id: 'p-other-acct', account_id: 'acct-2', conversation_id: null, objective: "Someone else's", status: 'running', created_at: '2026-09-02T00:00:00Z' },
  ];
  steps = [
    { id: 's1', plan_id: 'p-running', status: 'done' },
    { id: 's2', plan_id: 'p-running', status: 'pending' },
    { id: 's3', plan_id: 'p-blocked', status: 'blocked' },
  ];
}

beforeEach(() => {
  vi.resetModules();
  seedPlans();
});

describe('lib/plans/store.ts listPlans', () => {
  it('returns every active plan plus only the 5 most recent terminal ones, scoped to the account', async () => {
    const { listPlans } = await import('@/lib/plans/store');
    const rows = await listPlans('acct-1');

    // Never another account's plan.
    expect(rows.find((r) => r.id === 'p-other-acct')).toBeUndefined();

    // Every active plan present — the 5-cap only applies to terminal statuses.
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(['p-running', 'p-blocked', 'p-draft']));

    // 8 done plans exist; only 5 surface.
    const doneRows = rows.filter((r) => r.status === 'done');
    expect(doneRows.length).toBe(5);
  });

  it('sorts the combined list newest first', async () => {
    const { listPlans } = await import('@/lib/plans/store');
    const rows = await listPlans('acct-1');
    const createdAts = rows.map((r) => r.createdAt);
    const sorted = [...createdAts].sort().reverse();
    expect(createdAts).toEqual(sorted);
  });

  it('reports real step counts and the conversation id for a plan it saw', async () => {
    const { listPlans } = await import('@/lib/plans/store');
    const rows = await listPlans('acct-1');
    const running = rows.find((r) => r.id === 'p-running')!;
    expect(running.stepsDone).toBe(1);
    expect(running.stepsTotal).toBe(2);
    expect(running.conversationId).toBe('c1');
    expect(running.objective).toBe('Running one');
  });

  it('returns [] rather than throwing when the account has no plans', async () => {
    plans = []; steps = [];
    const { listPlans } = await import('@/lib/plans/store');
    expect(await listPlans('acct-nobody')).toEqual([]);
  });
});

describe('listPlans capability — registry wiring', () => {
  it('is registered right after getPlan and before startPlan in CATALOG_ORDER', async () => {
    const { CAPABILITIES } = await import('@/lib/capabilities/registry');
    const names = CAPABILITIES.map((c) => c.name);
    const getPlanIdx = names.indexOf('getPlan');
    const listPlansIdx = names.indexOf('listPlans');
    const startPlanIdx = names.indexOf('startPlan');
    expect(getPlanIdx).toBeGreaterThanOrEqual(0);
    expect(listPlansIdx).toBe(getPlanIdx + 1);
    expect(startPlanIdx).toBe(listPlansIdx + 1);
  });

  it('is a read-gated workspace capability that takes no arguments', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const cap = CAPABILITY_BY_NAME.listPlans;
    expect(cap.gate).toBe('read');
    expect(cap.domain).toBe('workspace');
    expect(cap.zod.safeParse({}).success).toBe(true);
    expect(Object.keys(cap.inputSchema.properties || {})).toEqual([]);
  });

  it('appears in toolSpecs() — reachable over MCP the same way every other capability is (parity)', async () => {
    const { toolSpecs } = await import('@/lib/agent/tools');
    const specs = toolSpecs();
    expect(specs.some((s) => s.name === 'listPlans')).toBe(true);
  });
});

describe('listPlans capability — run() and digest never invent what they did not see', () => {
  it('run() returns exactly what lib/plans/store.listPlans returned, nothing added', async () => {
    const { PLAN_CAPABILITIES } = await import('@/lib/capabilities/plans');
    const cap = PLAN_CAPABILITIES.find((c) => c.name === 'listPlans')!;
    const result = await cap.run('acct-1', {}, {});
    const { listPlans } = await import('@/lib/plans/store');
    expect(result).toEqual({ plans: await listPlans('acct-1') });
  });

  it('digest reports "no plans" rather than a fabricated count when the result carries none', async () => {
    const { PLAN_CAPABILITIES } = await import('@/lib/capabilities/plans');
    const cap = PLAN_CAPABILITIES.find((c) => c.name === 'listPlans')!;
    expect(cap.digest!({}, { plans: [] })).toMatch(/no plans/i);
  });

  it('digest returns empty (never invents a count) for a missing/malformed result', async () => {
    const { PLAN_CAPABILITIES } = await import('@/lib/capabilities/plans');
    const cap = PLAN_CAPABILITIES.find((c) => c.name === 'listPlans')!;
    expect(cap.digest!({}, undefined)).toBe('');
    expect(cap.digest!({}, null)).toBe('');
    expect(cap.digest!({}, { plans: 'not-an-array' })).toBe('');
  });

  it('digest counts only the plans actually present in the result', async () => {
    const { PLAN_CAPABILITIES } = await import('@/lib/capabilities/plans');
    const cap = PLAN_CAPABILITIES.find((c) => c.name === 'listPlans')!;
    const three = [
      { id: '1', status: 'running' }, { id: '2', status: 'blocked' }, { id: '3', status: 'done' },
    ];
    const digest = cap.digest!({}, { plans: three });
    expect(digest).toContain('3');
    // Never a bigger number than what was actually in the result.
    const five = [...three, { id: '4', status: 'done' }, { id: '5', status: 'done' }];
    expect(cap.digest!({}, { plans: five })).toContain('5');
    expect(cap.digest!({}, { plans: five })).not.toContain('3 plan');
  });
});

// tests/goal-loop.test.ts — cross-session goals (migration 048).
//
// Everything else the assistant does is single-turn: ask, get an artefact,
// done. A goal outlives the conversation, so the ONE thing that has to hold is
// that a later session can read what an earlier one did and continue. That is
// not a model behaviour — it is what these three capabilities write and read —
// so it is testable without a model, which matters because it had never been
// exercised at all.
//
// The load-bearing invariant: THE ACTOR MAY NOT MOVE ITS OWN GOALPOSTS.
// logGoalProgress can append work and can declare the bar cleared, but it must
// never rewrite success_criterion. A struggling agent that can edit the
// criterion will always "succeed", and the goal loop becomes theatre.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db as fake } from './support/fake-supabase';

vi.mock('@/lib/db', async () => {
  const { db } = await import('./support/fake-supabase');
  const BRAND = { id: 'brand_1', name: 'Northwind', account_id: 'acct_1' };
  return {
    supabase: db.client,
    getVenture: async (id: string) => (id === BRAND.id ? BRAND : null),
    getVentures: async () => [BRAND],
  };
});

const { GOAL_CAPABILITIES } = await import('@/lib/capabilities/goals');
const cap = (n: string) => GOAL_CAPABILITIES.find((c) => c.name === n)!;
const ACCOUNT = 'acct_1';

const rows = () => fake.tableRows('brand_goals');
beforeEach(() => fake.reset());

async function makeGoal(objective = 'Fill the Q4 pipeline', criterion = '40 qualified demos booked by 31 Dec') {
  return cap('createGoal').run(ACCOUNT, { objective, successCriterion: criterion });
}

describe('a goal must be checkable to exist', () => {
  it('is created with both an objective and a criterion', async () => {
    const r: any = await makeGoal();
    expect(r.goal.objective).toBe('Fill the Q4 pipeline');
    expect(r.goal.success_criterion).toBe('40 qualified demos booked by 31 Dec');
    expect(r.goal.status).toBe('active');
  });

  it('the schema refuses a goal with no criterion', () => {
    // Without a checkable criterion a goal is a wish and the loop never
    // terminates — so it is required at creation, not optional.
    const parsed = cap('createGoal').zod.safeParse({ objective: 'Grow' });
    expect(parsed.success).toBe(false);
  });

  it('the digest states the bar, not just the objective', async () => {
    const r = await makeGoal();
    const d = cap('createGoal').digest!({}, r);
    expect(d).toContain('40 qualified demos');
  });
});

describe('a later session can pick up where an earlier one stopped', () => {
  it('progress written in one call is readable in the next', async () => {
    const created: any = await makeGoal();
    await cap('logGoalProgress').run(ACCOUNT, { goalId: created.goal.id, note: 'Drafted the outreach sequence.' });
    await cap('logGoalProgress').run(ACCOUNT, { goalId: created.goal.id, note: 'Sourced 120 leads in the ICP.' });

    const listed: any = await cap('listGoals').run(ACCOUNT, {});
    expect(listed).toHaveLength(1);
    expect(listed[0].progressEntries).toBe(2);
    expect(JSON.stringify(listed[0].progress_log)).toContain('Sourced 120 leads');
  });

  it('each entry is timestamped so the order of work survives', async () => {
    const created: any = await makeGoal();
    await cap('logGoalProgress').run(ACCOUNT, { goalId: created.goal.id, note: 'first' });
    const log = rows()[0].progress_log;
    expect(log[0].at).toBeTruthy();
    expect(Number.isFinite(Date.parse(log[0].at))).toBe(true);
  });

  it('a long history is trimmed for the model but never truncated on disk', async () => {
    // The model only needs the recent shape of the log; the record must stay
    // whole, or "what has been tried already" degrades every session.
    const created: any = await makeGoal();
    for (let i = 0; i < 9; i++) {
      await cap('logGoalProgress').run(ACCOUNT, { goalId: created.goal.id, note: `step ${i}` });
    }
    const listed: any = await cap('listGoals').run(ACCOUNT, {});
    expect(listed[0].progress_log).toHaveLength(5);
    expect(listed[0].progressEntries).toBe(9);
    expect(rows()[0].progress_log).toHaveLength(9);
  });

  it('listGoals says something useful when there is nothing to resume', async () => {
    expect(cap('listGoals').digest!({}, [])).toBe('No goals set.');
  });
});

describe('the actor may not move its own goalposts', () => {
  it('logGoalProgress cannot rewrite the success criterion', async () => {
    const created: any = await makeGoal();
    const original = rows()[0].success_criterion;

    // Ask it to, in every way the interface allows.
    await cap('logGoalProgress').run(ACCOUNT, {
      goalId: created.goal.id,
      note: 'Reframing success as "some interest shown".',
      successCriterion: 'anything at all',
      success_criterion: 'anything at all',
    } as any);

    expect(rows()[0].success_criterion).toBe(original);
  });

  it('the schema does not even accept a criterion on the progress call', () => {
    const parsed: any = cap('logGoalProgress').zod.safeParse({
      goalId: 'g1', note: 'x', successCriterion: 'lowered',
    });
    // Either rejected, or stripped before it can reach the patch.
    if (parsed.success) expect(parsed.data.successCriterion).toBeUndefined();
  });

  it('it MAY declare the bar cleared — that is not the same power', async () => {
    const created: any = await makeGoal();
    const r: any = await cap('logGoalProgress').run(ACCOUNT, {
      goalId: created.goal.id, note: '41 demos booked, target passed.', markMet: true,
    });
    expect(r.status).toBe('met');
    expect(rows()[0].status).toBe('met');
    expect(rows()[0].met_at).toBeTruthy();
    // And the criterion it was judged against is reported back, unchanged.
    expect(r.criterion).toBe('40 qualified demos booked by 31 Dec');
  });
});

describe('tenancy', () => {
  it('another account cannot log progress on this goal', async () => {
    const created: any = await makeGoal();
    const r: any = await cap('logGoalProgress').run('acct_intruder', { goalId: created.goal.id, note: 'mine now' });
    expect(r.error).toBe('Goal not found');
    expect(rows()[0].progress_log).toHaveLength(0);
  });

  it('listGoals only returns this account\'s goals', async () => {
    await makeGoal();
    const listed: any = await cap('listGoals').run('acct_intruder', {});
    expect(listed).toHaveLength(0);
  });
});

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
const loadTranscriptMock = vi.fn(async (..._a: any[]) => [] as any[]);
const saveConversationMock = vi.fn(async (..._a: any[]) => 'conv-saved');

// D1 (G15) — approval resume. Keyed by approval id, per-test.
let approvalRows: Record<string, { id: string; state: string; tool: string } | undefined> = {};
let approvalArgs: Record<string, Record<string, any> | null> = {};
const getApprovalMock = vi.fn(async (_accountId: string, id: string) => approvalRows[id] ?? null);
const decryptApprovalArgsMock = vi.fn(async (_accountId: string, id: string) => approvalArgs[id] ?? null);
vi.mock('@/lib/approvals/store', () => ({
  getApproval: (...a: any[]) => getApprovalMock(...(a as [any, any])),
  decryptApprovalArgs: (...a: any[]) => decryptApprovalArgsMock(...(a as [any, any])),
}));

// D2 (G14) — grounding. loadAgentContext never throws in reality; the mock
// mirrors that by returning a fixed string unless a test overrides it.
const loadAgentContextMock = vi.fn(async (..._a: any[]) => 'GROUNDING BLOCK');
vi.mock('@/lib/agent/context', () => ({
  loadAgentContext: (...a: any[]) => loadAgentContextMock(...(a as [any])),
}));

function rowsFor(table: string) { return table === 'agent_plans' ? plans : steps; }

vi.mock('@/lib/db', () => ({
  supabase: {
    // Mirrors advance_plan_step_cursor's real semantics (migration 079): a
    // single conditional update, only against a row still `in_progress`,
    // resetting attempts to 0 on success — see tests/plan-store-batch.test.ts
    // for the same guard exercised directly against lib/plans/store.ts.
    rpc: async (fn: string, params: any) => {
      if (fn !== 'advance_plan_step_cursor') return { data: null, error: null };
      const row = steps.find((s: any) => s.id === params.p_step_id);
      if (!row || row.status !== 'in_progress') return { data: [], error: null };
      const by = Math.max(0, Math.floor(params.p_by) || 0);
      const raw = (row.cursor ?? 0) + by;
      const newCursor = row.total != null ? Math.min(raw, row.total) : raw;
      row.cursor = newCursor;
      row.attempts = 0;
      const done = row.total != null && newCursor >= row.total;
      if (!done) row.status = 'pending';
      return { data: [{ new_cursor: newCursor, step_total: row.total }], error: null };
    },
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
vi.mock('@/lib/agent/memory', () => ({
  loadTranscript: (...a: any[]) => loadTranscriptMock(...a),
  saveConversation: (...a: any[]) => saveConversationMock(...a),
}));

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

function seedBatch(opts: { over: string[]; cursor?: number; attempts?: number; itemsPerTick?: number } = { over: [] }) {
  plans = [{
    id: 'p1', account_id: 'acct-1', conversation_id: 'c1', brand_id: null,
    objective: 'Work the leads', status: 'running',
    max_steps: 200, steps_used: 0,
    expires_at: new Date(Date.now() + 3600_000).toISOString(), last_error: null,
  }];
  steps = [{
    id: 's1', plan_id: 'p1', seq: 1, title: 'Handle every lead', status: 'pending',
    result: null, attempts: opts.attempts ?? 0, blocked_reason: null, approval_id: null,
    over: opts.over, cursor: opts.cursor ?? 0, total: opts.over.length,
  }];
  if (opts.itemsPerTick != null) process.env.PLAN_ITEMS_PER_TICK = String(opts.itemsPerTick);
  else delete process.env.PLAN_ITEMS_PER_TICK;
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

  it('frames the step through the prompt-improver, naming that one step', async () => {
    // Structured GOAL/INPUTS/RULES/DELIVERABLE rather than an ad-hoc sentence:
    // a resumed step arrives with no conversational lead-up, which is exactly
    // the shallow one-liner that scaffolding exists to fix.
    await tick();
    const msg = String(runAgent.mock.calls[0]?.[0]?.message ?? '');
    expect(msg).toContain('GOAL:');
    expect(msg).toContain('DELIVERABLE:');
    expect(msg).toContain('First');          // this step's title
    expect(msg).toContain('s1');             // its id, so it can be closed
    // Told to read the plan, not rewrite it — restating the objective as a
    // task is what makes the model re-plan instead of execute.
    expect(msg).toMatch(/read it rather than re-planning/i);
  });

  it('carries the pinned skills and persona so guidance cannot drift', async () => {
    // A plan is worked one step per tick and each step is a different message.
    // Without pinning, step 3 routes to different skills than step 1 and the
    // work changes character partway through.
    plans[0].skills = ['seo', 'ads'];
    plans[0].persona_id = 'persona-1';
    await tick();
    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.pinnedSkills).toEqual(['seo', 'ads']);
    expect(input?.personaId).toBe('persona-1');
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

// ---------------------------------------------------------------------------
// Batch steps (migration 079) — one step iterating a list across ticks.
//
// The property that matters: no item is ever processed twice and none is
// skipped, across a crashed tick, a parked approval, and two concurrent
// ticks. Each block below targets exactly one of those three failure modes.
// ---------------------------------------------------------------------------

describe('a batch step spans multiple ticks and completes exactly once', () => {
  beforeEach(() => {
    vi.resetModules(); runAgent.mockClear();
    agentResult = { status: 'done', message: 'batch tick ok', steps: [{}, {}], transcript: [] };
  });

  it('advances the cursor a slice at a time and only finishes on the tick that reaches the end', async () => {
    const items = Array.from({ length: 20 }, (_, i) => `lead-${i}`);
    seedBatch({ over: items, itemsPerTick: 8 });

    let r = await tick();                      // items 0..7
    expect(steps[0].cursor).toBe(8);
    expect(steps[0].status).toBe('pending');    // NOT done, re-claimable next tick
    expect(r.stepsCompleted).toBe(0);

    r = await tick();                           // items 8..15
    expect(steps[0].cursor).toBe(16);
    expect(steps[0].status).toBe('pending');
    expect(r.stepsCompleted).toBe(0);

    r = await tick();                           // items 16..19 (only 4 left)
    expect(steps[0].cursor).toBe(20);
    expect(steps[0].status).toBe('done');
    expect(r.stepsCompleted).toBe(1);            // completes EXACTLY once

    // A later tick must not touch the finished step again.
    runAgent.mockClear();
    const r2 = await tick();
    expect(runAgent).not.toHaveBeenCalled();
    expect(r2.stepsCompleted).toBe(0);
  });

  it('REVERT-CHECK TARGET: every item is processed exactly once — the full sequence of slices matches the list with no repeats and no gaps', async () => {
    const items = Array.from({ length: 10 }, (_, i) => `lead-${i}`);
    seedBatch({ over: items, itemsPerTick: 3 });

    const slicesSeen: string[] = [];
    for (let guard = 0; guard < 10 && steps[0].status !== 'done'; guard++) {
      await tick();
      const msg = String(runAgent.mock.calls[runAgent.mock.calls.length - 1][0].message);
      const m = msg.match(/Items to handle THIS TURN ONLY: ([^\n]+)/);
      if (m) slicesSeen.push(...m[1].split('; '));
    }
    expect(steps[0].status).toBe('done');
    expect(slicesSeen).toEqual(items); // exact order, no repeats, none skipped
  });

  it('does not call completePlanStep-style single-shot closure — the runner, not the model, completes it', async () => {
    // Guards against the batch prompt accidentally reusing the ordinary
    // step's "call completePlanStep" instruction, which would close the step
    // after only the first slice.
    seedBatch({ over: ['a', 'b', 'c'], itemsPerTick: 8 });
    await tick();
    const msg = String(runAgent.mock.calls[0][0].message);
    expect(msg).toMatch(/do not call completePlanStep/i);
  });
});

describe('a crashed or failed tick leaves a batch step re-claimable', () => {
  beforeEach(() => { vi.resetModules(); runAgent.mockClear(); });

  it('REVERT-CHECK TARGET: an error result does not advance the cursor, and the step returns to pending', async () => {
    const items = Array.from({ length: 10 }, (_, i) => `lead-${i}`);
    seedBatch({ over: items, cursor: 4, itemsPerTick: 3 });
    agentResult = { status: 'error', message: 'upstream died', steps: [], transcript: [] };

    await tick();
    expect(steps[0].cursor).toBe(4);            // untouched
    expect(steps[0].status).toBe('pending');     // re-claimable, not stuck in_progress
    expect(steps[0].attempts).toBe(1);           // the failed tick counted

    // Next tick, with a healthy result, resumes from the SAME slice rather
    // than skipping past it.
    agentResult = { status: 'done', message: 'ok', steps: [{}], transcript: [] };
    await tick();
    const msg = String(runAgent.mock.calls[runAgent.mock.calls.length - 1][0].message);
    expect(msg).toContain('lead-4'); // the item the failed tick was supposed to do
    expect(msg).not.toContain('lead-7'); // not skipped ahead
    expect(steps[0].cursor).toBe(7);
  });

  it('REVERT-CHECK TARGET: a thrown exception (not a returned error) also leaves the step re-claimable, cursor untouched', async () => {
    seedBatch({ over: ['a', 'b', 'c', 'd'], cursor: 1, itemsPerTick: 2 });
    runAgent.mockImplementationOnce(async () => { throw new Error('container died'); });

    await tick();
    expect(steps[0].cursor).toBe(1);
    expect(steps[0].status).toBe('pending');
  });
});

describe('MAX_STEP_ATTEMPTS counts consecutive failed TICKS, not total ticks worked', () => {
  beforeEach(() => { vi.resetModules(); runAgent.mockClear(); });

  it('REVERT-CHECK TARGET: a 20-item step at 3 items/tick (7 ticks) does not block itself despite every tick succeeding', async () => {
    const items = Array.from({ length: 20 }, (_, i) => `lead-${i}`);
    seedBatch({ over: items, itemsPerTick: 3 });
    agentResult = { status: 'done', message: 'ok', steps: [{}], transcript: [] };

    for (let i = 0; i < 10 && steps[0].status !== 'done'; i++) {
      const r = await tick();
      expect(r.stepsBlocked).toBe(0); // never blocked on the way
    }
    expect(steps[0].status).toBe('done');
    expect(steps[0].cursor).toBe(20);
  });

  it('still blocks after three CONSECUTIVE failing ticks with no progress between them', async () => {
    seedBatch({ over: Array.from({ length: 10 }, (_, i) => `lead-${i}`), itemsPerTick: 2 });
    agentResult = { status: 'error', message: 'down', steps: [], transcript: [] };

    await tick(); // attempts -> 1
    await tick(); // attempts -> 2
    const r = await tick(); // attempts would reach 3 on the NEXT claim
    // Attempts reached 3 exactly after the third failed claim; the fourth
    // tick sees attempts >= MAX_STEP_ATTEMPTS before claiming and blocks.
    expect(steps[0].attempts).toBe(3);
    const r2 = await tick();
    expect(steps[0].status).toBe('blocked');
    expect(r2.stepsBlocked).toBe(1);
    expect(steps[0].cursor).toBe(0); // nothing was ever skipped or double-run
  });
});

describe('an approval parks a batch step without advancing its cursor', () => {
  beforeEach(() => { vi.resetModules(); runAgent.mockClear(); });

  it('REVERT-CHECK TARGET: needs_approval leaves the cursor exactly where it was, and resuming continues from the same item', async () => {
    const items = Array.from({ length: 10 }, (_, i) => `lead-${i}`);
    seedBatch({ over: items, cursor: 4, itemsPerTick: 3 });
    agentResult = {
      status: 'needs_approval', message: 'needs you',
      proposal: { approvalId: 'appr-1', summary: 'Send outreach to 3 leads' },
      steps: [{}], transcript: [],
    };

    const r = await tick();
    expect(r.stepsBlocked).toBe(1);
    expect(steps[0].status).toBe('blocked');
    expect(steps[0].approval_id).toBe('appr-1');
    expect(steps[0].cursor).toBe(4); // untouched by the park

    // Resume: releases the step, cursor still untouched.
    const { resumeStepForApproval } = await import('@/lib/plans/store');
    expect(await resumeStepForApproval('acct-1', 'appr-1')).toBe(true);
    expect(steps[0].status).toBe('pending');
    expect(steps[0].cursor).toBe(4);

    // The next tick works the SAME slice the approval interrupted, not the
    // one after it.
    agentResult = { status: 'done', message: 'ok', steps: [{}], transcript: [] };
    await tick();
    const msg = String(runAgent.mock.calls[runAgent.mock.calls.length - 1][0].message);
    expect(msg).toContain('lead-4');
    expect(msg).not.toContain('lead-7');
    expect(steps[0].cursor).toBe(7);
  });
});

describe('two concurrent ticks cannot both advance the same batch step', () => {
  beforeEach(() => { vi.resetModules(); runAgent.mockClear(); });

  // Integration-level pin: claimStep's pre-existing atomicity is what stops
  // the second tick before it ever calls runAgent (revert-checked directly
  // against claimStep would also break unrelated updates in this shared fake
  // client, so it is not repeated here); advanceCursor's OWN atomicity is
  // revert-checked in isolation in tests/plan-store-batch.test.ts.
  it('only one of two racing ticks does the work; the cursor moves by exactly one slice', async () => {
    const items = Array.from({ length: 20 }, (_, i) => `lead-${i}`);
    seedBatch({ over: items, itemsPerTick: 8 });
    agentResult = { status: 'done', message: 'ok', steps: [{}], transcript: [] };

    const [r1, r2] = await Promise.all([tick(), tick()]);
    // Exactly one tick's worth of items (8) advanced — not 16, not 0.
    expect(steps[0].cursor).toBe(8);
    expect(runAgent).toHaveBeenCalledTimes(1);
    void r1; void r2;
  });
});

describe('a step with no `over` behaves exactly as before batch steps existed', () => {
  beforeEach(() => {
    vi.resetModules(); runAgent.mockClear();
    agentResult = { status: 'done', message: 'Did it.', steps: [{}, {}], transcript: [] };
    seed(); // the pre-existing helper — no `over` on either step
  });

  it('completes in one tick via completePlanStep-style closure, same as before', async () => {
    const r = await tick();
    expect(r.stepsCompleted).toBe(1);
    expect(steps.find((s: any) => s.id === 's1')!.status).toBe('done');
  });

  it('never mentions batch-only language for an ordinary step', async () => {
    await tick();
    const msg = String(runAgent.mock.calls[0][0].message);
    expect(msg).not.toMatch(/do not call completePlanStep/i);
    expect(msg).not.toContain('Items to handle THIS TURN ONLY');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — progress reporting. A batch step that advances across many ticks
// should report itself into its own conversation ("31 of 95 done"), the same
// way a human watching a long job would expect — reusing the EXISTING
// conversation writer (loadTranscript + saveConversation, lib/agent/memory.ts)
// rather than a second write path.
// ---------------------------------------------------------------------------
describe('batch progress is reported into the plan\'s conversation', () => {
  beforeEach(() => {
    vi.resetModules(); runAgent.mockClear();
    loadTranscriptMock.mockClear(); saveConversationMock.mockClear();
    loadTranscriptMock.mockResolvedValue([]);
    agentResult = { status: 'done', message: 'batch tick ok', steps: [{}], transcript: [] };
  });

  it('appends a short "N of M done" line on advance', async () => {
    const items = Array.from({ length: 10 }, (_, i) => `lead-${i}`);
    seedBatch({ over: items, itemsPerTick: 3 });

    await tick();

    expect(loadTranscriptMock).toHaveBeenCalledWith('c1', 'acct-1');
    expect(saveConversationMock).toHaveBeenCalledTimes(1);
    const saved = saveConversationMock.mock.calls[0][0];
    expect(saved.id).toBe('c1');
    expect(saved.accountId).toBe('acct-1');
    const lastMsg = saved.transcript[saved.transcript.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.content).toMatch(/3 of 10 done/);
  });

  it('is NOT appended when the plan has no conversationId', async () => {
    const items = Array.from({ length: 10 }, (_, i) => `lead-${i}`);
    seedBatch({ over: items, itemsPerTick: 3 });
    plans[0].conversation_id = null;

    await tick();

    expect(loadTranscriptMock).not.toHaveBeenCalled();
    expect(saveConversationMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// G15 — approving a blocked plan step must RESUME it through runAgent's
// existing approve/consume path, not just release it back to `pending` and
// let the model propose the same sensitive call again (which re-blocks
// forever and never executes). See lib/plans/runner.ts's grantedApprovalFor.
// ---------------------------------------------------------------------------
describe('a step with a granted approval is resumed through it (G15)', () => {
  beforeEach(() => {
    vi.resetModules(); runAgent.mockClear();
    getApprovalMock.mockClear(); decryptApprovalArgsMock.mockClear();
    approvalRows = {}; approvalArgs = {};
    agentResult = { status: 'done', message: 'Sent.', steps: [{}], transcript: [] };
    seed();
    // Simulate what resumeStepForApproval already leaves behind: the step
    // back to `pending` (so nextStep picks it up), approval_id still set
    // (unblockStep never clears it — clearing only happens after a real
    // resume, which is exactly what this test is proving).
    steps[0].approval_id = 'appr-1';
  });

  it('hands runAgent the approvalId, tool, and decrypted args of an APPROVED row', async () => {
    approvalRows['appr-1'] = { id: 'appr-1', state: 'approved', tool: 'sendEmail' };
    approvalArgs['appr-1'] = { to: 'lead@example.com', subject: 'Hi' };

    await tick();

    expect(getApprovalMock).toHaveBeenCalledWith('acct-1', 'appr-1');
    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.approve).toEqual({
      approvalId: 'appr-1', tool: 'sendEmail', args: { to: 'lead@example.com', subject: 'Hi' },
    });
  });

  it('clears the approval off the step once it has been handed to runAgent and the step did not re-block', async () => {
    approvalRows['appr-1'] = { id: 'appr-1', state: 'approved', tool: 'sendEmail' };
    approvalArgs['appr-1'] = { to: 'lead@example.com' };

    await tick();

    expect(steps[0].approval_id).toBeNull();
  });

  it('does NOT pass approve for a row in state "executed" — single-use, already spent', async () => {
    approvalRows['appr-1'] = { id: 'appr-1', state: 'executed', tool: 'sendEmail' };
    approvalArgs['appr-1'] = { to: 'lead@example.com' };

    await tick();

    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.approve).toBeUndefined();
  });

  it('does NOT pass approve for a row still in state "pending" — nobody has granted it yet', async () => {
    approvalRows['appr-1'] = { id: 'appr-1', state: 'pending', tool: 'sendEmail' };
    approvalArgs['appr-1'] = { to: 'lead@example.com' };

    await tick();

    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.approve).toBeUndefined();
  });

  it('does NOT pass approve when there is no approval row at all', async () => {
    // approvalRows stays empty — getApproval resolves null.
    await tick();
    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.approve).toBeUndefined();
  });

  it('degrades to no approve, without throwing, when decryptApprovalArgs returns null', async () => {
    approvalRows['appr-1'] = { id: 'appr-1', state: 'approved', tool: 'sendEmail' };
    // approvalArgs['appr-1'] left unset -> decryptApprovalArgsMock resolves null.

    const r = await tick();

    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.approve).toBeUndefined();
    expect(r.stepsCompleted).toBe(1); // the tick still completed the step normally
  });

  it('a step with no approval_id at all never calls getApproval — the common case stays cheap', async () => {
    steps[0].approval_id = null;
    await tick();
    expect(getApprovalMock).not.toHaveBeenCalled();
    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.approve).toBeUndefined();
  });

  it('same behaviour on the BATCH path: a batch step resumed with a granted approval passes it through', async () => {
    const items = Array.from({ length: 5 }, (_, i) => `lead-${i}`);
    seedBatch({ over: items, itemsPerTick: 3 });
    steps[0].approval_id = 'appr-1';
    approvalRows['appr-1'] = { id: 'appr-1', state: 'approved', tool: 'sendEmail' };
    approvalArgs['appr-1'] = { to: 'lead@example.com' };
    agentResult = { status: 'done', message: 'ok', steps: [{}], transcript: [] };

    await tick();

    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.approve).toEqual({
      approvalId: 'appr-1', tool: 'sendEmail', args: { to: 'lead@example.com' },
    });
    expect(steps[0].approval_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// G14 — a plan step must run GROUNDED: the same venture profile, account
// snapshot, durable memory, and conversation transcript an interactive turn
// gets, via loadAgentContext / loadTranscript. Without it "the plan is in
// your context above" is false and a step cannot see what earlier steps did.
// ---------------------------------------------------------------------------
describe('a plan step is grounded like an interactive turn (G14)', () => {
  beforeEach(() => {
    vi.resetModules(); runAgent.mockClear();
    loadAgentContextMock.mockClear(); loadTranscriptMock.mockClear();
    loadAgentContextMock.mockResolvedValue('VENTURE + ACCOUNT + MEMORY GROUNDING');
    loadTranscriptMock.mockResolvedValue([{ role: 'user', content: 'earlier turn' }]);
    agentResult = { status: 'done', message: 'Did it.', steps: [{}], transcript: [] };
    seed();
  });

  it('single-shot step: passes a non-empty agentContext, built from the plan\'s account/brand/conversation', async () => {
    await tick();
    expect(loadAgentContextMock).toHaveBeenCalledWith({
      accountId: 'acct-1', brandId: undefined, conversationId: 'c1', query: 'First',
    });
    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.agentContext).toBe('VENTURE + ACCOUNT + MEMORY GROUNDING');
  });

  it('single-shot step: passes the conversation transcript', async () => {
    await tick();
    expect(loadTranscriptMock).toHaveBeenCalledWith('c1', 'acct-1');
    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.transcript).toEqual([{ role: 'user', content: 'earlier turn' }]);
  });

  it('batch step: passes a non-empty agentContext and the transcript too', async () => {
    const items = Array.from({ length: 5 }, (_, i) => `lead-${i}`);
    seedBatch({ over: items, itemsPerTick: 3 });

    await tick();

    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.agentContext).toBe('VENTURE + ACCOUNT + MEMORY GROUNDING');
    expect(input?.transcript).toEqual([{ role: 'user', content: 'earlier turn' }]);
  });

  it('degrades to no agentContext, without throwing, when loadAgentContext fails', async () => {
    loadAgentContextMock.mockRejectedValueOnce(new Error('down'));
    const r = await tick();
    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.agentContext).toBeUndefined();
    expect(r.stepsCompleted).toBe(1); // the tick still completes — grounding is best-effort
  });

  it('does not fetch a transcript when the plan has no conversationId', async () => {
    plans[0].conversation_id = null;
    await tick();
    expect(loadTranscriptMock).not.toHaveBeenCalled();
    const input = runAgent.mock.calls[0]?.[0];
    expect(input?.transcript).toBeUndefined();
  });
});

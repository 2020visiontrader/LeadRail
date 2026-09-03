// HOLE 1 (turn-ceiling audit): lib/scheduled/store.ts's runDueScheduledTasks
// is reachable from TWO callers — app/api/hermes/tick/route.ts and the
// standalone app/api/scheduled-tasks/run-due route — with no claim of any
// kind, so the same due task could be run twice concurrently: two full agent
// turns, possibly two sends of whatever the task's prompt asks for.
//
// claimScheduledTask (migration 084) fixes this the SAME way claimStep
// (lib/plans/store.ts) does: a conditional UPDATE guarded on the row's own
// current state, not a JS read-then-write — so of two callers racing the
// same row, only one can ever see its UPDATE return a row.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let tasks: any[] = [];

// A fake supabase client that actually enforces the WHERE clause of an
// UPDATE the same way Postgres would for a conditional claim: rows not
// matching every .eq()/.or() filter are excluded from what gets patched AND
// from what comes back in `data` — the same "only a row that still matches
// gets touched, and only that row is reported" semantics claimScheduledTask
// depends on for its return value.
function makeSupabase() {
  return {
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      if (table !== 'scheduled_tasks') {
        // Unrelated tables (brands, etc.) used by groundingFor — always empty.
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        } as any;
      }
      const q: any = {
        _f: [] as ((r: any) => boolean)[],
        _mode: 'select' as 'select' | 'update',
        _patch: null as any,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
        lte(c: string, v: any) { q._f.push((r: any) => r[c] <= v); return q; },
        limit() { return q; },
        // Minimal parser for the two .or() forms this store actually issues:
        // "run_state.eq.idle,claimed_at.lt.<iso>"
        or(expr: string) {
          const clauses = expr.split(',').map((c) => {
            const [field, op, ...rest] = c.split('.');
            const value = rest.join('.');
            return (r: any) => {
              if (op === 'eq') return r[field] === value;
              if (op === 'lt') return r[field] != null && r[field] < value;
              return false;
            };
          });
          q._f.push((r: any) => clauses.some((f: (r: any) => boolean) => f(r)));
          return q;
        },
        update(p: any) { q._mode = 'update'; q._patch = p; return q; },
        then(resolve: any) {
          const matched = tasks.filter((r) => q._f.every((f: (r: any) => boolean) => f(r)));
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

let supabaseMock: any;
vi.mock('@/lib/db', () => ({ supabase: new Proxy({}, { get: (_t, p) => supabaseMock[p] }) }));
vi.mock('@/lib/agent/context', () => ({ loadAgentContext: async () => 'ctx' }));
vi.mock('@/lib/notifications/store', () => ({ createNotification: async () => {} }));
vi.mock('@/lib/agent/memory', () => ({
  loadTranscript: async () => [],
  saveConversation: async () => 'conv-1',
}));
const runAgent = vi.fn(async (..._a: any[]) => ({ status: 'done', message: 'ok', transcript: [] as any[] }));
vi.mock('@/lib/agent/loop', () => ({ runAgent: (...a: any[]) => runAgent(...a) }));

function seedTask(overrides: Partial<any> = {}) {
  tasks = [{
    id: 't1', account_id: 'acct-1', brand_id: null, name: 'Task', prompt: 'do it',
    interval: 'daily', enabled: true, last_run_at: null,
    next_run_at: new Date(Date.now() - 1000).toISOString(),
    last_status: null, last_result: null, conversation_id: null, active_plan_id: null,
    run_state: 'idle', claimed_at: null,
    ...overrides,
  }];
}

beforeEach(() => {
  vi.resetModules();
  runAgent.mockClear();
  supabaseMock = makeSupabase();
  seedTask();
});

describe('claimScheduledTask', () => {
  it('REVERT-CHECK TARGET: claims an idle task (conditional UPDATE, not read-then-write)', async () => {
    const { claimScheduledTask } = await import('@/lib/scheduled/store');
    const ok = await claimScheduledTask('t1');
    expect(ok).toBe(true);
    expect(tasks[0].run_state).toBe('running');
    expect(tasks[0].claimed_at).toBeTruthy();
  });

  it('a second concurrent claim on the same already-running task fails', async () => {
    const { claimScheduledTask } = await import('@/lib/scheduled/store');
    const first = await claimScheduledTask('t1');
    const second = await claimScheduledTask('t1');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('a claim older than SCHEDULED_CLAIM_STALE_MS is reclaimable (crash recovery)', async () => {
    seedTask({ run_state: 'running', claimed_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    const { claimScheduledTask } = await import('@/lib/scheduled/store');
    const ok = await claimScheduledTask('t1');
    expect(ok).toBe(true);
  });
});

describe('runDueScheduledTasks does not run the same due task twice for two concurrent callers', () => {
  it('a task already claimed (running, not stale) by one caller is skipped by a second sweep', async () => {
    const { runDueScheduledTasks, claimScheduledTask } = await import('@/lib/scheduled/store');
    // Simulate caller A already having claimed the task (e.g. the hermes
    // tick got there first) before caller B's sweep runs.
    const claimedByA = await claimScheduledTask('t1');
    expect(claimedByA).toBe(true);

    const result = await runDueScheduledTasks();
    expect(result.processed).toBe(0);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('an idle due task is claimed and actually run', async () => {
    const { runDueScheduledTasks } = await import('@/lib/scheduled/store');
    const result = await runDueScheduledTasks();
    expect(result.processed).toBe(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
    // Released back to idle once the run finishes, so the NEXT sweep can
    // claim it again on its next due firing.
    expect(tasks[0].run_state).toBe('idle');
  });

  it('stops claiming further tasks once deadlineAt has passed, and reports them as skipped rather than dropped', async () => {
    tasks = [
      { id: 't1', account_id: 'acct-1', brand_id: null, name: 'A', prompt: 'a', interval: 'daily', enabled: true, last_run_at: null, next_run_at: new Date(Date.now() - 1000).toISOString(), last_status: null, last_result: null, conversation_id: null, active_plan_id: null, run_state: 'idle', claimed_at: null },
      { id: 't2', account_id: 'acct-1', brand_id: null, name: 'B', prompt: 'b', interval: 'daily', enabled: true, last_run_at: null, next_run_at: new Date(Date.now() - 1000).toISOString(), last_status: null, last_result: null, conversation_id: null, active_plan_id: null, run_state: 'idle', claimed_at: null },
    ];
    const { runDueScheduledTasks } = await import('@/lib/scheduled/store');
    // Deadline already in the past — nothing should be claimed or run.
    const result = await runDueScheduledTasks(Date.now() - 1);
    expect(result.processed).toBe(0);
    expect(runAgent).not.toHaveBeenCalled();
    expect(result.skipped.sort()).toEqual(['t1', 't2']);
    // run_state untouched — a skipped task was never claimed, so it remains
    // idle and eligible for the next sweep, not stuck.
    expect(tasks[0].run_state).toBe('idle');
    expect(tasks[1].run_state).toBe('idle');
  });
});

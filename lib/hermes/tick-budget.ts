// Shared time budget for app/api/hermes/tick/route.ts's engine sweep.
//
// Lives here rather than as an export on the route file itself: Next.js
// validates route.ts's exports against a fixed known set (GET/POST/other
// verbs, dynamic, runtime, maxDuration, revalidate, fetchCache,
// preferredRegion, ...) and rejects an arbitrary extra named export like this
// one at build time (`npx next build` fails), even though it runs fine under
// `next dev` and under vitest. Keeping it in its own lib module, imported by
// both the route and its tests, means the test asserts against the exact
// value the route uses — not a duplicated literal that could drift from it.
//
// Checked BETWEEN the tick's engines (never used to abort one mid-flight):
// once elapsed time since the tick started reaches this, no engine that
// hasn't started yet is started. Exists because the seven engines the tick
// drains have no ceiling of their own on how long ONE of them can run (the
// standout being runDueScheduledTasks: up to 25 sequential full agent turns),
// so nothing previously stopped one slow engine from starving every engine
// after it for the rest of the tick.
export const TICK_TIME_BUDGET_MS = Number(process.env.HERMES_TICK_TIME_BUDGET_MS) || 4 * 60 * 1000;

// ORDERING + AN EXPLICIT CAP, not just ordering — this is the fix for a
// starvation regression a coordinator review caught in this same packet.
//
// A sequential, budget-gated tick trades a real property away: under the
// PREVIOUS Promise.all, every engine started on every tick and total time was
// the max of the seven; sequential execution makes total time the SUM, and
// ORDER now decides who can be starved. runDueScheduledTasks (up to 25
// sequential full agent turns) is the one engine of the seven capable of
// consuming the ENTIRE TICK_TIME_BUDGET_MS by itself — if it sat ahead of
// runPlanTick or runMemoryExtraction in the run order, a single account with
// a scheduled-task backlog could silently starve the plan runner and memory
// extraction on every tick, forever, while the tick itself still logged a
// healthy 200. That is the exact defect (agent_plans / agent_memory reachable
// but never actually invoked — see BACKLOG.md #13 and commits 2ed611a /
// 8e16cb2, which fixed the plan runner and its entry point specifically so
// plans could finally run) reopened through a different door.
//
// THE FIX has two parts, both required — reordering alone is not a bound:
//   1. app/api/hermes/tick/route.ts orders runDueScheduledTasks LAST, after
//      every other engine including plans and memory, so it can never sit
//      ahead of them and consume their share of the budget.
//   2. Even last, "runs until the tick's shared deadline" would still let it
//      eat 100% of whatever budget happens to remain — SCHEDULED_TASKS_SUB_
//      BUDGET_MS caps it independently: its own deadline is
//      min(tick deadline, its own start time + this constant), so being
//      ordered last is not what bounds it — this constant is. Half of
//      TICK_TIME_BUDGET_MS: generous enough for a real backlog to make
//      progress every tick, small enough that it can never by itself consume
//      the whole run even if every other engine finished instantly.
export const SCHEDULED_TASKS_SUB_BUDGET_MS = Math.floor(TICK_TIME_BUDGET_MS / 2);

// generations retention purge (lib/generations/store.ts's
// purgeExpiredGenerations) — the LOWEST-priority work in the tick. It runs
// last, after every engine above AND after the tick's existing best-effort
// housekeeping (soft-delete purge, account purge, reward maturation, app-log
// retention), and is capped to its own small, fixed slice rather than
// sharing TICK_TIME_BUDGET_MS or running unbounded: none of the seven
// engines' correctness depends on generations ever being purged on any
// particular tick (an unpurged backlog just means slightly higher storage
// use until the next tick), so it must never be able to delay or crowd out
// work that other things DO depend on. 20s is generous for the couple of
// small, indexed batch deletes purgeExpiredGenerations actually issues.
export const GENERATIONS_PURGE_BUDGET_MS = 20 * 1000;

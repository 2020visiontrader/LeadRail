import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { processDueJobs } from '@/lib/hermes/agent';
import { processDueEnrollments } from '@/lib/sequences';
import { processEnrichmentJobs } from '@/lib/enrichment-jobs';
import { processDueWebhookDeliveries } from '@/lib/webhooks-out';
import { requireAuth, errorResponse } from '@/lib/http';
import { supabase } from '@/lib/db';
import { purgeDueAccounts } from '@/lib/privacy';
import { maturateRewards } from '@/lib/referrals';
import { runDueScheduledTasks } from '@/lib/scheduled/store';
import { runMemoryExtraction } from '@/lib/memory/extract';
import { runPlanTick } from '@/lib/plans/runner';
import { TICK_TIME_BUDGET_MS, SCHEDULED_TASKS_SUB_BUDGET_MS } from '@/lib/hermes/tick-budget';

export const dynamic = 'force-dynamic';
// No explicit `runtime`/`maxDuration` here previously, so the platform
// applied its own default ceiling — on a tick that drains six engines,
// one of which (runDueScheduledTasks) can run up to 25 sequential full agent
// turns inline, that default is nowhere near enough. Node is required for the
// same reason app/api/agent/route.ts needs it (supabase-js, node crypto via
// this route's dependency graph).
export const runtime = 'nodejs';
// INVARIANT, same shape as lib/agent/loop.ts's TURN_DEADLINE_MS /
// app/api/agent/route.ts's maxDuration=300 pairing (see
// tests/turn-deadline-invariant.test.ts): this must stay comfortably above
// TICK_TIME_BUDGET_MS below, with margin for the one already-started unit of
// work the budget check does NOT interrupt.
//
// TICK_TIME_BUDGET_MS (240s) bounds when this tick STARTS new engine work;
// it does not bound an engine already running. The worst already-started
// unit across all seven engines is runPlanTick's single agent turn, capped
// at TURN_DEADLINE_MS (270s, lib/agent/loop.ts) — runDueScheduledTasks is
// bounded tighter still, to SCHEDULED_TASKS_SUB_BUDGET_MS (120s, lib/hermes/
// tick-budget.ts), so it is never the worst case despite running last. So
// worst case: budget (240s) elapses right as the last-started engine begins,
// that engine runs its own full 270s, plus the small, fast retention/purge
// housekeeping after — 600s leaves ~90s of margin over that ~510s worst
// case, comfortably over the 15s this codebase already treats as the
// minimum real margin.
export const maxDuration = 600;
// TICK_TIME_BUDGET_MS itself lives in lib/hermes/tick-budget.ts, NOT as an
// export here — Next.js validates route.ts exports against a fixed known set
// and rejects an arbitrary extra one at `next build` time even though it runs
// fine under `next dev`/vitest. See that file's header for the full reasoning.

const skipped = (reason: string) => ({ skipped: true as const, reason });

// Cron entrypoint. Schedule via a Supabase scheduled function, or any cron
// that can POST, every few minutes. Protected by APP_API_SECRET.
async function POST__impl(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '25', 10), 100);
    // Drain the engines: legacy hermes_jobs, the canonical sequence_enrollments,
    // and the async enrichment-job queue (Phase C #17).
    // Memory extraction rides the existing tick rather than a new cron. A
    // second scheduler is a second thing that can silently stop without
    // anything noticing, and this codebase already has enough of those.
    //
    // Run SEQUENTIALLY, each gated on the shared budget, rather than the
    // previous Promise.all: a shared "stop starting new work" budget only
    // means something when engines are asked to start one at a time — under
    // Promise.all every engine already started the instant the tick began,
    // so nothing could have been "not started yet" for the budget to gate.
    const deadline = Date.now() + TICK_TIME_BUDGET_MS;
    const results: Record<string, unknown> = {};
    // ORDER MATTERS — see SCHEDULED_TASKS_SUB_BUDGET_MS's comment in
    // lib/hermes/tick-budget.ts for the starvation regression this ordering
    // (plus that engine's own explicit sub-budget below) exists to prevent.
    // scheduledTasks — the one engine of the seven able to consume the whole
    // tick by itself — runs LAST, after every other engine including plans
    // and memory, so it can never sit ahead of them and starve their share.
    const engines: { key: string; run: () => Promise<unknown> }[] = [
      { key: 'legacy', run: () => processDueJobs(limit) },
      { key: 'sequences', run: () => processDueEnrollments(limit) },
      { key: 'enrichment', run: () => processEnrichmentJobs(Math.min(limit, 10)) },
      { key: 'webhooks', run: () => processDueWebhookDeliveries(Math.min(limit, 20)) },
      // Plans advance one step per tick — see lib/plans/runner.ts for why one.
      { key: 'plans', run: () => runPlanTick() },
      { key: 'memory', run: () => runMemoryExtraction() },
      {
        key: 'scheduledTasks',
        // NOT the shared tick `deadline` — that would only bound this engine
        // by however much budget happened to be left when its turn came,
        // which is "ordered later", not a cap. min(tick deadline, this
        // engine's OWN start time + SCHEDULED_TASKS_SUB_BUDGET_MS) bounds it
        // independently of position: even if every engine before it returned
        // instantly and the full tick budget remained, this engine still
        // cannot consume more than its own explicit share. Also still stops
        // its internal loop (up to 25 sequential agent turns) from claiming
        // NEW tasks once that deadline passes, same as before.
        run: () => runDueScheduledTasks(Math.min(deadline, Date.now() + SCHEDULED_TASKS_SUB_BUDGET_MS)),
      },
    ];
    for (const engine of engines) {
      if (Date.now() >= deadline) {
        results[engine.key] = skipped('hermes tick time budget exhausted before this engine could start');
        continue;
      }
      try {
        results[engine.key] = await engine.run();
      } catch (e: any) {
        results[engine.key] = { error: String(e?.message || e) };
      }
    }
    const { legacy, sequences, enrichment, webhooks, scheduledTasks, memory, plans } = results as any;
    // Retention cron: hard-purge rows soft-deleted past the window, then
    // hard-purge accounts whose deletion grace window has elapsed (storage +
    // cascade). Both best-effort; a failure never fails the tick.
    const { data: purged } = await supabase.rpc('purge_soft_deleted', { p_days: 30 });
    const purgedAccounts = await purgeDueAccounts(25).catch(() => [] as string[]);
    const maturedRewards = await maturateRewards().catch(() => 0);
    // App-log retention: bound table growth by dropping rows older than 90 days.
    await supabase.from('app_logs').delete().lt('created_at', new Date(Date.now() - 90 * 864e5).toISOString()).then(
      () => {}, () => {},
    );
    return NextResponse.json({
      ok: true, legacy, sequences, enrichment, webhooks, scheduledTasks, memory, plans,
      purged: purged ?? 0, purgedAccounts: purgedAccounts.length, maturedRewards,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/hermes/tick", method: "POST" });

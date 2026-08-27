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

export const dynamic = 'force-dynamic';

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
    const [legacy, sequences, enrichment, webhooks, scheduledTasks, memory] = await Promise.all([
      processDueJobs(limit).catch((e) => ({ error: String(e?.message || e) })),
      processDueEnrollments(limit).catch((e) => ({ error: String(e?.message || e) })),
      processEnrichmentJobs(Math.min(limit, 10)).catch((e) => ({ error: String(e?.message || e) })),
      processDueWebhookDeliveries(Math.min(limit, 20)).catch((e) => ({ error: String(e?.message || e) })),
      runDueScheduledTasks().catch((e) => ({ error: String(e?.message || e) })),
      runMemoryExtraction().catch((e) => ({ error: String(e?.message || e) })),
    ]);
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
      ok: true, legacy, sequences, enrichment, webhooks, scheduledTasks, memory,
      purged: purged ?? 0, purgedAccounts: purgedAccounts.length, maturedRewards,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/hermes/tick", method: "POST" });

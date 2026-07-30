import { NextRequest, NextResponse } from 'next/server';
import { processDueJobs } from '@/lib/hermes/agent';
import { processDueEnrollments } from '@/lib/sequences';
import { processEnrichmentJobs } from '@/lib/enrichment-jobs';
import { processDueWebhookDeliveries } from '@/lib/webhooks-out';
import { requireAuth, errorResponse } from '@/lib/http';
import { supabase } from '@/lib/db';
import { purgeDueAccounts } from '@/lib/privacy';
import { maturateRewards } from '@/lib/referrals';

export const dynamic = 'force-dynamic';

// Cron entrypoint. Schedule via Vercel Cron or Supabase scheduled function
// to POST here every few minutes. Protected by APP_API_SECRET.
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '25', 10), 100);
    // Drain the engines: legacy hermes_jobs, the canonical sequence_enrollments,
    // and the async enrichment-job queue (Phase C #17).
    const [legacy, sequences, enrichment, webhooks] = await Promise.all([
      processDueJobs(limit).catch((e) => ({ error: String(e?.message || e) })),
      processDueEnrollments(limit).catch((e) => ({ error: String(e?.message || e) })),
      processEnrichmentJobs(Math.min(limit, 10)).catch((e) => ({ error: String(e?.message || e) })),
      processDueWebhookDeliveries(Math.min(limit, 20)).catch((e) => ({ error: String(e?.message || e) })),
    ]);
    // Retention cron: hard-purge rows soft-deleted past the window, then
    // hard-purge accounts whose deletion grace window has elapsed (storage +
    // cascade). Both best-effort; a failure never fails the tick.
    const { data: purged } = await supabase.rpc('purge_soft_deleted', { p_days: 30 });
    const purgedAccounts = await purgeDueAccounts(25).catch(() => [] as string[]);
    const maturedRewards = await maturateRewards().catch(() => 0);
    return NextResponse.json({
      ok: true, legacy, sequences, enrichment, webhooks,
      purged: purged ?? 0, purgedAccounts: purgedAccounts.length, maturedRewards,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

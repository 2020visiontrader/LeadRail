import { NextRequest, NextResponse } from 'next/server';
import { processDueJobs } from '@/lib/hermes/agent';
import { processDueEnrollments } from '@/lib/sequences';
import { requireAuth, errorResponse } from '@/lib/http';
import { supabase } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Cron entrypoint. Schedule via Vercel Cron or Supabase scheduled function
// to POST here every few minutes. Protected by APP_API_SECRET.
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '25', 10), 100);
    // Drain both engines: legacy hermes_jobs and the canonical sequence_enrollments.
    const [legacy, sequences] = await Promise.all([
      processDueJobs(limit).catch((e) => ({ error: String(e?.message || e) })),
      processDueEnrollments(limit).catch((e) => ({ error: String(e?.message || e) })),
    ]);
    // Trash cron: hard-purge rows soft-deleted past the retention window.
    // Best-effort; a purge failure (or 010 not yet applied) never fails the tick.
    const { data: purged } = await supabase.rpc('purge_soft_deleted', { p_days: 30 });
    return NextResponse.json({ ok: true, legacy, sequences, purged: purged ?? 0 });
  } catch (error) {
    return errorResponse(error);
  }
}

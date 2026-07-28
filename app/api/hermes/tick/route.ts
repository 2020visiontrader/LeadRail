import { NextRequest, NextResponse } from 'next/server';
import { processDueJobs } from '@/lib/hermes/agent';
import { processDueEnrollments } from '@/lib/sequences';
import { requireAuth, errorResponse } from '@/lib/http';

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
    return NextResponse.json({ ok: true, legacy, sequences });
  } catch (error) {
    return errorResponse(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { processDueJobs } from '@/lib/hermes/agent';
import { requireAuth, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// Cron entrypoint. Schedule via Vercel Cron or Supabase scheduled function
// to POST here every few minutes. Protected by APP_API_SECRET.
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '25', 10), 100);
    const result = await processDueJobs(limit);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}

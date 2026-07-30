import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getMyCode, createMyCode, normalizeCode } from '@/lib/referrals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET — the caller's ambassador code (or null).
export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const code = await getMyCode(session.accountId);
  return NextResponse.json({ code });
}

// POST { desired?: string } — create (or return) the caller's ambassador code.
export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not configured');
  let desired: string | undefined;
  try { desired = (await request.json())?.desired; } catch { /* optional */ }
  if (desired && normalizeCode(desired).length < 3) return badRequest('code must be at least 3 letters/numbers');
  try {
    const code = await createMyCode(session.accountId, session.email, desired);
    return NextResponse.json({ code });
  } catch (e) { return errorResponse(e); }
}

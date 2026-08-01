import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getMyCode, createMyCode, normalizeCode } from '@/lib/referrals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET — the caller's ambassador code (or null).
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const code = await getMyCode(session.accountId);
  return NextResponse.json({ code });
}

// POST { desired?: string } — create (or return) the caller's ambassador code.
async function POST__impl(request: NextRequest) {
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

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/referrals/code", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/referrals/code", method: "POST" });

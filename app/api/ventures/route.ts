import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getVentures, createVenture, dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// GET /api/ventures — ventures (brands) for the caller's account only.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ ventures: [], db_ready: false });
  try {
    const ventures = await getVentures(session.accountId);
    return NextResponse.json({ ventures, db_ready: true });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST /api/ventures — create a new venture (brand) for the caller's account.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not configured');
  try {
    const body = await request.json().catch(() => ({}));
    const name = String(body?.name || '').trim();
    if (!name) return badRequest('name is required');
    const venture = await createVenture(session.accountId, name, {
      description: body?.description ? String(body.description) : undefined,
      lead_goal: body?.leadGoal ? String(body.leadGoal) : undefined,
      sectors: Array.isArray(body?.sectors) ? body.sectors.map(String) : undefined,
      skills: Array.isArray(body?.skills) ? body.skills.map(String) : undefined,
    });
    return NextResponse.json({ venture }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/ventures", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/ventures", method: "POST" });

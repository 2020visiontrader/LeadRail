import { NextRequest, NextResponse } from 'next/server';
import { getVenture, updateVenture, assertBrandOwned, dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { softDeleteVenture } from '@/lib/privacy';

export const dynamic = 'force-dynamic';

// GET /api/ventures/:id — one venture (account-scoped), including its profile.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not configured');
  if (!(await assertBrandOwned(params.id, session.accountId))) return badRequest('unknown venture');
  try {
    return NextResponse.json({ venture: await getVenture(params.id) });
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH /api/ventures/:id — update profile fields (description, goal, sectors,
// skills). Account-scoped in the DB layer.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not configured');
  if (!(await assertBrandOwned(params.id, session.accountId))) return badRequest('unknown venture');
  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const patch: Record<string, any> = {};
  if (body?.name !== undefined) patch.name = String(body.name).trim();
  if (body?.description !== undefined) patch.description = String(body.description).slice(0, 4000);
  if (body?.leadGoal !== undefined) patch.lead_goal = String(body.leadGoal);
  if (Array.isArray(body?.sectors)) patch.sectors = body.sectors.map(String);
  if (Array.isArray(body?.skills)) patch.skills = body.skills.map(String);
  try {
    return NextResponse.json({ venture: await updateVenture(params.id, session.accountId, patch) });
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE /api/ventures/:id — soft-delete a venture. It disappears from lists
// immediately and is hard-purged (with its contacts) after the retention window.
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not configured');
  if (!(await assertBrandOwned(params.id, session.accountId))) return badRequest('unknown venture');
  try {
    const res = await softDeleteVenture(params.id, session.accountId, session.email);
    return NextResponse.json({ ok: true, deleted: !!res });
  } catch (e) {
    return errorResponse(e);
  }
}

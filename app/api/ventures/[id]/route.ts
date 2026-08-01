import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getVenture, updateVenture, assertBrandOwned, dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { softDeleteVenture } from '@/lib/privacy';

export const dynamic = 'force-dynamic';

// GET /api/ventures/:id — one venture (account-scoped), including its profile.
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
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
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
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
  // Sender profile / persona (per venture). Plain-language identity fields that
  // the generator maps into the internal persona; ['auto'] skills = goal picks.
  if (body?.senderName !== undefined) patch.sender_name = String(body.senderName).slice(0, 120);
  if (body?.senderRole !== undefined) patch.sender_role = String(body.senderRole).slice(0, 120);
  if (body?.senderEmail !== undefined) patch.sender_email = String(body.senderEmail).slice(0, 200).trim();
  if (body?.pitch !== undefined) patch.pitch = String(body.pitch).slice(0, 600);
  if (body?.tone !== undefined) patch.tone = String(body.tone).slice(0, 120);
  if (body?.signature !== undefined) patch.signature = String(body.signature).slice(0, 1000);
  if (body?.defaultCta !== undefined) patch.default_cta = String(body.defaultCta).slice(0, 300);
  try {
    return NextResponse.json({ venture: await updateVenture(params.id, session.accountId, patch) });
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE /api/ventures/:id — soft-delete a venture. It disappears from lists
// immediately and is hard-purged (with its contacts) after the retention window.
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
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

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/ventures/[id]", method: "GET" });
export const PATCH = withApi(PATCH__impl as any, { route: "/api/ventures/[id]", method: "PATCH" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/ventures/[id]", method: "DELETE" });

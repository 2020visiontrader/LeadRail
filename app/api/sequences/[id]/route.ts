import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getSequence, updateSequence, deleteSequence, setSequenceSteps } from '@/lib/sequences';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    return NextResponse.json(await getSequence(ctx.params.id, session.accountId));
  } catch (error) {
    return errorResponse(error, 404, 'sequence not found');
  }
}

async function PATCH__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    // When steps are provided, replace the cadence (edit-after-create).
    if (Array.isArray(body.steps)) {
      await setSequenceSteps(ctx.params.id, session.accountId, body.steps);
    }
    // Metadata fields (name/channel/is_active) go through updateSequence.
    const meta = await updateSequence(ctx.params.id, session.accountId, body).catch(() => null);
    return NextResponse.json(meta ?? (await getSequence(ctx.params.id, session.accountId)));
  } catch (error) {
    return errorResponse(error);
  }
}

async function DELETE__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    return NextResponse.json(await deleteSequence(ctx.params.id, session.accountId));
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/sequences/[id]", method: "GET" });
export const PATCH = withApi(PATCH__impl as any, { route: "/api/sequences/[id]", method: "PATCH" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/sequences/[id]", method: "DELETE" });

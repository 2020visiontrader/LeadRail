import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { listEnrollments } from '@/lib/sequences';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// GET /api/sequences/:id/enrollments — who is enrolled + a status rollup.
async function GET__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    return NextResponse.json(await listEnrollments(ctx.params.id, session.accountId));
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/sequences/[id]/enrollments", method: "GET" });

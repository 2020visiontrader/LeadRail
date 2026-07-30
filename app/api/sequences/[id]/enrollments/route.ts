import { NextRequest, NextResponse } from 'next/server';
import { listEnrollments } from '@/lib/sequences';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// GET /api/sequences/:id/enrollments — who is enrolled + a status rollup.
export async function GET(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    return NextResponse.json(await listEnrollments(ctx.params.id, session.accountId));
  } catch (error) {
    return errorResponse(error);
  }
}

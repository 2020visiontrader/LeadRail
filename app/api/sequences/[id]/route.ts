import { NextRequest, NextResponse } from 'next/server';
import { getSequence, updateSequence, deleteSequence } from '@/lib/sequences';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    return NextResponse.json(await getSequence(ctx.params.id, session.accountId));
  } catch (error) {
    return errorResponse(error, 404, 'sequence not found');
  }
}

export async function PATCH(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    return NextResponse.json(await updateSequence(ctx.params.id, session.accountId, body));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    return NextResponse.json(await deleteSequence(ctx.params.id, session.accountId));
  } catch (error) {
    return errorResponse(error);
  }
}

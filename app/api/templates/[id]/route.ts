import { NextRequest, NextResponse } from 'next/server';
import { deleteTemplate, dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function DELETE(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    return NextResponse.json(await deleteTemplate(ctx.params.id, session.accountId));
  } catch (error) {
    return errorResponse(error);
  }
}

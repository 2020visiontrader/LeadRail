import { NextRequest, NextResponse } from 'next/server';
import { dbReady, deleteConnection } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function DELETE(request: NextRequest, ctx: { params: { provider: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const result = await deleteConnection(session.accountId, ctx.params.provider);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

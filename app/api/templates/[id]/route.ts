import { NextRequest, NextResponse } from 'next/server';
import { deleteTemplate, dbReady } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function DELETE(request: NextRequest, ctx: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  if (!dbReady()) return badRequest('database not connected');
  try {
    return NextResponse.json(await deleteTemplate(ctx.params.id));
  } catch (error) {
    return errorResponse(error);
  }
}

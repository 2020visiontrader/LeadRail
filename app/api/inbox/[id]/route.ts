import { NextRequest, NextResponse } from 'next/server';
import { markInboxRead, dbReady } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// PATCH /api/inbox/:id  body: { is_read?: boolean }
export async function PATCH(request: NextRequest, ctx: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await markInboxRead(ctx.params.id, body?.is_read ?? true));
  } catch (error) {
    return errorResponse(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { moveDealStage } from '@/lib/crm';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const { stage_id } = await request.json();
    if (!stage_id) return badRequest('stage_id is required');
    return NextResponse.json(await moveDealStage(params.id, session.accountId, stage_id));
  } catch (error) { return errorResponse(error); }
}

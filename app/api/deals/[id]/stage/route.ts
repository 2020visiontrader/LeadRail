import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { moveDealStage } from '@/lib/crm';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const { stage_id } = await request.json();
    if (!stage_id) return badRequest('stage_id is required');
    return NextResponse.json(await moveDealStage(params.id, session.accountId, stage_id));
  } catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const PATCH = withApi(PATCH__impl as any, { route: "/api/deals/[id]/stage", method: "PATCH" });

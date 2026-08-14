import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import {
  getJourney,
  updateJourney,
  deleteJourney,
  validateGraph,
  VALID_STATUS,
  VALID_TRIGGER,
  type JourneyStatus,
  type JourneyTrigger,
} from '@/lib/journeys/store';

export const dynamic = 'force-dynamic';

// GET /api/journeys/:id — fetch one journey (account-scoped).
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const journey = await getJourney(session.accountId, params.id);
    if (!journey) return badRequest('unknown journey');
    return NextResponse.json(journey);
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH /api/journeys/:id — update name/description/status/trigger/graph.
// Ownership enforced inside updateJourney (WHERE account_id = session).
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const status = body?.status !== undefined ? String(body.status) as JourneyStatus : undefined;
    if (status && !VALID_STATUS.includes(status)) return badRequest(`status must be one of: ${VALID_STATUS.join(', ')}`);
    const trigger = body?.trigger !== undefined ? String(body.trigger) as JourneyTrigger : undefined;
    if (trigger && !VALID_TRIGGER.includes(trigger)) return badRequest(`trigger must be one of: ${VALID_TRIGGER.join(', ')}`);
    if (body?.graph !== undefined) {
      const gErr = validateGraph(body.graph);
      if (gErr) return badRequest(gErr);
    }
    const journey = await updateJourney(session.accountId, params.id, {
      name: body?.name !== undefined ? String(body.name) : undefined,
      description: body?.description !== undefined ? String(body.description) : undefined,
      status,
      trigger,
      graph: body?.graph,
    });
    return NextResponse.json(journey);
  } catch (e: any) {
    if (e?.message === 'journey not found') return badRequest('unknown journey');
    return errorResponse(e);
  }
}

// DELETE /api/journeys/:id
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json(await deleteJourney(session.accountId, params.id));
  } catch (e: any) {
    if (e?.message === 'journey not found') return badRequest('unknown journey');
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/journeys/[id]', method: 'GET' });
export const PATCH = withApi(PATCH__impl as any, { route: '/api/journeys/[id]', method: 'PATCH' });
export const DELETE = withApi(DELETE__impl as any, { route: '/api/journeys/[id]', method: 'DELETE' });

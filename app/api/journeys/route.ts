import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import {
  listJourneys,
  createJourney,
  validateGraph,
  VALID_TRIGGER,
  type JourneyTrigger,
} from '@/lib/journeys/store';

export const dynamic = 'force-dynamic';

// GET /api/journeys — list this account's journeys.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ journeys: [] });
  try {
    const journeys = await listJourneys(session.accountId);
    return NextResponse.json({ journeys });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/journeys — create a journey. account_id always comes from the
// session, never the client body. Graph (if supplied) is validated first.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const name = String(body?.name || '').trim();
    if (!name) return badRequest('name is required');
    const trigger = (body?.trigger ? String(body.trigger) : 'manual') as JourneyTrigger;
    if (!VALID_TRIGGER.includes(trigger)) return badRequest(`trigger must be one of: ${VALID_TRIGGER.join(', ')}`);
    if (body?.graph) {
      const gErr = validateGraph(body.graph);
      if (gErr) return badRequest(gErr);
    }
    const journey = await createJourney(session.accountId, {
      name,
      description: body?.description ? String(body.description) : undefined,
      trigger,
      graph: body?.graph,
    });
    return NextResponse.json(journey, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/journeys', method: 'GET' });
export const POST = withApi(POST__impl as any, { route: '/api/journeys', method: 'POST' });

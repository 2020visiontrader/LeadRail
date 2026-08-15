import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { listPipelineRuns, runPipeline } from '@/lib/pipeline/store';

export const dynamic = 'force-dynamic';

// GET /api/pipeline — list this account's content-pipeline runs (newest first).
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ runs: [] });
  try {
    const runs = await listPipelineRuns(session.accountId);
    return NextResponse.json({ runs });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/pipeline — start a run for a topic. account_id always comes from
// the session, never the client body. Runs the full 6-stage pipeline inline.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json().catch(() => ({}));
    const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
    if (!topic) return badRequest('topic is required');
    const run = await runPipeline(session.accountId, topic);
    return NextResponse.json({ run }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/pipeline", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/pipeline", method: "POST" });

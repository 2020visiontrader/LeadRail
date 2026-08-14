import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getPipelineRun } from '@/lib/pipeline/store';

export const dynamic = 'force-dynamic';

// GET /api/pipeline/:id — fetch one content-pipeline run (account-scoped).
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const run = await getPipelineRun(session.accountId, params.id);
    if (!run) return badRequest('unknown pipeline run');
    return NextResponse.json({ run });
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/pipeline/[id]", method: "GET" });

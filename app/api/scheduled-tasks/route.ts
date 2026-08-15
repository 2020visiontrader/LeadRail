import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { listScheduledTasks, createScheduledTask, type ScheduledInterval } from '@/lib/scheduled/store';

export const dynamic = 'force-dynamic';

const VALID_INTERVALS: ScheduledInterval[] = ['hourly', 'daily', 'weekly'];

// GET /api/scheduled-tasks — list this account's scheduled agent tasks.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ tasks: [] });
  try {
    const tasks = await listScheduledTasks(session.accountId);
    return NextResponse.json({ tasks });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/scheduled-tasks — create a scheduled task. account_id always
// comes from the session, never the client body.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const name = String(body?.name || '').trim();
    const prompt = String(body?.prompt || '').trim();
    const interval = String(body?.interval || '') as ScheduledInterval;
    if (!name) return badRequest('name is required');
    if (!prompt) return badRequest('prompt is required');
    if (!VALID_INTERVALS.includes(interval)) return badRequest(`interval must be one of: ${VALID_INTERVALS.join(', ')}`);
    const task = await createScheduledTask(session.accountId, {
      name,
      prompt,
      interval,
      enabled: body?.enabled !== false,
    });
    return NextResponse.json(task, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/scheduled-tasks", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/scheduled-tasks", method: "POST" });

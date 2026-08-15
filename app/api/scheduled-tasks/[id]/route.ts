import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getScheduledTask, updateScheduledTask, deleteScheduledTask, type ScheduledInterval } from '@/lib/scheduled/store';

export const dynamic = 'force-dynamic';

const VALID_INTERVALS: ScheduledInterval[] = ['hourly', 'daily', 'weekly'];

// GET /api/scheduled-tasks/:id — fetch one scheduled task (account-scoped).
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const task = await getScheduledTask(session.accountId, params.id);
    if (!task) return badRequest('unknown scheduled task');
    return NextResponse.json(task);
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH /api/scheduled-tasks/:id — update name/prompt/interval/enabled.
// Account ownership is enforced inside updateScheduledTask (WHERE account_id = session).
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const interval = body?.interval !== undefined ? String(body.interval) as ScheduledInterval : undefined;
    if (interval && !VALID_INTERVALS.includes(interval)) return badRequest(`interval must be one of: ${VALID_INTERVALS.join(', ')}`);
    const task = await updateScheduledTask(session.accountId, params.id, {
      name: body?.name !== undefined ? String(body.name) : undefined,
      prompt: body?.prompt !== undefined ? String(body.prompt) : undefined,
      interval,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : undefined,
    });
    return NextResponse.json(task);
  } catch (e: any) {
    if (e?.message === 'scheduled task not found') return badRequest('unknown scheduled task');
    return errorResponse(e);
  }
}

// DELETE /api/scheduled-tasks/:id
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json(await deleteScheduledTask(session.accountId, params.id));
  } catch (e: any) {
    if (e?.message === 'scheduled task not found') return badRequest('unknown scheduled task');
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/scheduled-tasks/[id]", method: "GET" });
export const PATCH = withApi(PATCH__impl as any, { route: "/api/scheduled-tasks/[id]", method: "PATCH" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/scheduled-tasks/[id]", method: "DELETE" });

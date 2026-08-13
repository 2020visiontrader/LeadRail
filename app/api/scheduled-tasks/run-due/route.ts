import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, errorResponse } from '@/lib/http';
import { runDueScheduledTasks } from '@/lib/scheduled/store';

export const dynamic = 'force-dynamic';

// Standalone sweep entrypoint for scheduled_tasks. Bearer APP_API_SECRET auth,
// same convention as /api/hermes/tick. An external scheduler (or the hermes
// tick handler — see app/api/hermes/tick/route.ts) POSTs here periodically.
async function POST__impl(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const result = await runDueScheduledTasks();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/scheduled-tasks/run-due", method: "POST" });

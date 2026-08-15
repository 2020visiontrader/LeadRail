import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getBudget, getBudgetStatus, upsertBudget } from '@/lib/budgets/store';

export const dynamic = 'force-dynamic';

// GET /api/budgets — this account's budget config + live status.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) {
    return NextResponse.json({
      config: null,
      status: { enabled: false, limit: null, spent: 0, remaining: null, pct: 0, alert: false, overLimit: false },
    });
  }
  try {
    const [config, status] = await Promise.all([
      getBudget(session.accountId),
      getBudgetStatus(session.accountId),
    ]);
    return NextResponse.json({ config, status });
  } catch (e) {
    return errorResponse(e);
  }
}

// PUT /api/budgets — upsert this account's budget config.
async function PUT__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const patch: Record<string, any> = {};
    if (body?.monthly_limit_credits !== undefined) {
      patch.monthly_limit_credits =
        body.monthly_limit_credits === null || body.monthly_limit_credits === ''
          ? null
          : Number(body.monthly_limit_credits);
    }
    if (body?.alert_threshold_pct !== undefined) patch.alert_threshold_pct = Number(body.alert_threshold_pct);
    if (body?.hard_stop !== undefined) patch.hard_stop = Boolean(body.hard_stop);
    if (body?.enabled !== undefined) patch.enabled = Boolean(body.enabled);

    await upsertBudget(session.accountId, patch);
    const [config, status] = await Promise.all([
      getBudget(session.accountId),
      getBudgetStatus(session.accountId),
    ]);
    return NextResponse.json({ config, status });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/budgets', method: 'GET' });
export const PUT = withApi(PUT__impl as any, { route: '/api/budgets', method: 'PUT' });

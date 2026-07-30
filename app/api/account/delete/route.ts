import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { requestAccountDeletion, cancelAccountDeletion, getAccount, DEFAULT_GRACE_DAYS } from '@/lib/privacy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET — current deletion status (so the UI can show the grace-window banner).
export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const acct = await getAccount(session.accountId);
  return NextResponse.json({
    scheduled_for: acct?.deletion_scheduled_for || null,
    requested_at: acct?.deletion_requested_at || null,
    grace_days: DEFAULT_GRACE_DAYS,
  });
}

// POST — owner requests account deletion. Soft: schedules a hard purge grace
// days out; the account keeps working until then and can cancel.
export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not configured');
  if (session.role !== 'owner') return NextResponse.json({ error: 'Only the account owner can delete the account' }, { status: 403 });
  let reason: string | undefined;
  try { reason = (await request.json())?.reason; } catch { /* body optional */ }
  try {
    const res = await requestAccountDeletion(session.accountId, session.email, DEFAULT_GRACE_DAYS, reason);
    return NextResponse.json({ ok: true, scheduled_for: res.deletion_scheduled_for, grace_days: DEFAULT_GRACE_DAYS });
  } catch (e) { return errorResponse(e); }
}

// DELETE — cancel a pending deletion during the grace window.
export async function DELETE(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (session.role !== 'owner') return NextResponse.json({ error: 'Only the account owner can manage deletion' }, { status: 403 });
  try {
    await cancelAccountDeletion(session.accountId, session.email);
    return NextResponse.json({ ok: true, canceled: true });
  } catch (e) { return errorResponse(e); }
}

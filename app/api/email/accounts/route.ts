import { withApi, requireSession, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getGmailAccount, disconnectGmailAccount, safeGmailAccount, getGmailRefreshToken } from '@/lib/email/gmail-account';
import { revokeGmailToken } from '@/lib/email/gmail';

export const dynamic = 'force-dynamic';

// GET: this account's Gmail connection (or null — there is at most one, see
// migrations/081_gmail_accounts.sql). Session-scoped; a caller can only ever
// see their own account_id's row because getGmailAccount filters in-query.
async function GET__impl(req: NextRequest) {
  const { session, error } = await requireSession(req);
  if (error) return error;
  try {
    const row = await getGmailAccount(session.accountId);
    return NextResponse.json({ account: row ? safeGmailAccount(row) : null });
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE: disconnect this account's Gmail connection. Best-effort revokes the
// refresh token at Google first, but succeeds locally regardless of whether
// that call did — a user asking to disconnect must not be told "no" because
// Google's revoke endpoint was briefly unreachable.
async function DELETE__impl(req: NextRequest) {
  const { session, error } = await requireSession(req);
  if (error) return error;
  try {
    const existing = await getGmailAccount(session.accountId);
    if (!existing) return NextResponse.json({ disconnected: false, reason: 'not_connected' });

    if (existing.secret_encrypted) {
      try {
        const refreshToken = await getGmailRefreshToken(session.accountId);
        await revokeGmailToken(refreshToken);
      } catch {
        // Best-effort only — see the function comment above.
      }
    }

    await disconnectGmailAccount(session.accountId);
    return NextResponse.json({ disconnected: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/email/accounts', method: 'GET' });
export const DELETE = withApi(DELETE__impl as any, { route: '/api/email/accounts', method: 'DELETE' });

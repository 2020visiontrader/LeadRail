import { withApi, requireSession } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { listAdAccounts } from '@/lib/social/meta-ads';

export const dynamic = 'force-dynamic';

// Lists the caller's Meta ad accounts for the campaign create UI. Never 500s on
// a missing/disconnected Meta connection — returns an empty list + reason.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const accounts = await listAdAccounts(session.accountId);
    return NextResponse.json({ accounts });
  } catch (e: any) {
    return NextResponse.json({ accounts: [], error: 'not_connected', detail: e?.message });
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/campaigns/meta/ad-accounts', method: 'GET' });

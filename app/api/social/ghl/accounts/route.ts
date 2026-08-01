import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getSocialAccounts, resolveGhlLocationId } from '@/lib/social/ghl';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const locationId = request.nextUrl.searchParams.get('locationId')
      || (await resolveGhlLocationId(session.accountId));
    if (!locationId) return badRequest('locationId required (none configured for this account)');
    const accounts = await getSocialAccounts(locationId);
    return NextResponse.json(accounts);
  } catch (error: any) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/social/ghl/accounts", method: "GET" });

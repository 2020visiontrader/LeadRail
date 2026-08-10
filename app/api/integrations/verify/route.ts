import { withApi, requireSession, badRequest } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifyNotion } from '@/lib/integrations/notion';
import { verifyGoogleDrive } from '@/lib/integrations/gdrive';

export const dynamic = 'force-dynamic';

// GET /api/integrations/verify?provider=notion|google_drive
// Live connectivity check for the connectors — returns { connected, ... } and
// never throws, so Settings can render an honest state.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const provider = request.nextUrl.searchParams.get('provider');
  if (provider === 'notion') return NextResponse.json({ provider, ...(await verifyNotion(session.accountId)) });
  if (provider === 'google_drive') return NextResponse.json({ provider, ...(await verifyGoogleDrive(session.accountId)) });
  return badRequest('provider must be notion or google_drive');
}

export const GET = withApi(GET__impl as any, { route: '/api/integrations/verify', method: 'GET' });

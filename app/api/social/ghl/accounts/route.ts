import { NextRequest, NextResponse } from 'next/server';
import { getSocialAccounts } from '@/lib/social/ghl';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  try {
    const locationId = request.nextUrl.searchParams.get('locationId');
    if (!locationId) return badRequest('locationId required');
    const accounts = await getSocialAccounts(locationId);
    return NextResponse.json(accounts);
  } catch (error: any) {
    return errorResponse(error);
  }
}

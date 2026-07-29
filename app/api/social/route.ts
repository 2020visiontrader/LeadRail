import { NextRequest, NextResponse } from 'next/server';
import { getIntegrations } from '@/lib/social';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const integrations = await getIntegrations(session.accountId);
    return NextResponse.json(integrations);
  } catch (error: any) {
    return errorResponse(error);
  }
}

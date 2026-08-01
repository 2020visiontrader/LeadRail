import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getIntegrations } from '@/lib/social';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const integrations = await getIntegrations(session.accountId);
    return NextResponse.json(integrations);
  } catch (error: any) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/social", method: "GET" });

import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getInstagramInsights } from '@/lib/integrations/meta';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  try {
    const mediaId = request.nextUrl.searchParams.get('mediaId');
    if (!mediaId) return badRequest('mediaId required');
    const insights = await getInstagramInsights(mediaId);
    return NextResponse.json(insights);
  } catch (error: any) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/social/meta/insights", method: "GET" });

import { NextRequest, NextResponse } from 'next/server';
import { getInstagramInsights } from '@/lib/integrations/meta';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
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

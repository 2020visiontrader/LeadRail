import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getCampaignAnalytics } from '@/lib/crm';
import { errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
async function GET__impl(request: NextRequest) {
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!brandId) return badRequest('brandId is required');
  try { return NextResponse.json(await getCampaignAnalytics(brandId)); }
  catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/campaigns/analytics", method: "GET" });

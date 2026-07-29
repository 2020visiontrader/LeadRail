import { NextRequest, NextResponse } from 'next/server';
import { getCampaignAnalytics } from '@/lib/crm';
import { errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!brandId) return badRequest('brandId is required');
  try { return NextResponse.json(await getCampaignAnalytics(brandId)); }
  catch (error) { return errorResponse(error); }
}

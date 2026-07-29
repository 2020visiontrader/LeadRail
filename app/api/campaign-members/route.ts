import { NextRequest, NextResponse } from 'next/server';
import { getCampaignMembers, addCampaignMembers } from '@/lib/crm';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const campaignId = request.nextUrl.searchParams.get('campaignId');
  if (!campaignId) return badRequest('campaignId is required');
  try { return NextResponse.json(await getCampaignMembers(campaignId)); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const { campaignId, accountId, contactIds } = await request.json();
    if (!campaignId || !accountId || !Array.isArray(contactIds) || !contactIds.length)
      return badRequest('campaignId, accountId, contactIds[] are required');
    return NextResponse.json(await addCampaignMembers(campaignId, accountId, contactIds), { status: 201 });
  } catch (error) { return errorResponse(error); }
}

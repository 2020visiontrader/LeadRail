import { NextRequest, NextResponse } from 'next/server';
import { getCampaignMembers, addCampaignMembers } from '@/lib/crm';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const campaignId = request.nextUrl.searchParams.get('campaignId');
  if (!campaignId) return badRequest('campaignId is required');
  try { return NextResponse.json(await getCampaignMembers(campaignId, session.accountId)); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const { campaignId, contactIds } = await request.json();
    if (!campaignId || !Array.isArray(contactIds) || !contactIds.length)
      return badRequest('campaignId, contactIds[] are required');
    return NextResponse.json(await addCampaignMembers(campaignId, session.accountId, contactIds), { status: 201 });
  } catch (error) { return errorResponse(error); }
}

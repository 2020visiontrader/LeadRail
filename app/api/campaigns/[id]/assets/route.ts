import { NextRequest, NextResponse } from 'next/server';
import { getCampaignAssets } from '@/lib/crm';
import { insertCampaignAsset } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
export async function GET(_r: NextRequest, { params }: { params: { id: string } }) {
  try { return NextResponse.json(await getCampaignAssets(params.id)); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const b = await request.json();
    if (!b?.account_id || !b?.url) return badRequest('account_id and url are required');
    return NextResponse.json(await insertCampaignAsset({ campaign_id: params.id, account_id: b.account_id, kind: b.kind || 'image', url: b.url, status: b.status || 'raw' }), { status: 201 });
  } catch (error) { return errorResponse(error); }
}

import { NextRequest, NextResponse } from 'next/server';
import { getCampaignAssets } from '@/lib/crm';
import { insertCampaignAsset } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await getCampaignAssets(params.id, session.accountId)); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const b = await request.json();
    if (!b?.url) return badRequest('url is required');
    return NextResponse.json(await insertCampaignAsset({ campaign_id: params.id, account_id: session.accountId, kind: b.kind || 'image', url: b.url, status: b.status || 'raw' }), { status: 201 });
  } catch (error) { return errorResponse(error); }
}

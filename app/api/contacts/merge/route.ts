import { NextRequest, NextResponse } from 'next/server';
import { mergeContacts } from '@/lib/crm';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const b = await request.json();
    if (!b?.accountId || !b?.survivingId || !b?.mergedId) return badRequest('accountId, survivingId, mergedId are required');
    return NextResponse.json(await mergeContacts({ accountId: b.accountId, survivingId: b.survivingId, mergedId: b.mergedId, actorEmail: b.actorEmail, reason: b.reason }), { status: 200 });
  } catch (error) { return errorResponse(error); }
}

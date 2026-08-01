import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { mergeContacts } from '@/lib/crm';
import { getContact } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
export const dynamic = 'force-dynamic';
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const b = await request.json();
    if (!b?.survivingId || !b?.mergedId) return badRequest('survivingId, mergedId are required');
    // Assert both contacts belong to the caller's account before merging.
    await getContact(b.survivingId, session.accountId);
    await getContact(b.mergedId, session.accountId);
    return NextResponse.json(await mergeContacts({ accountId: session.accountId, survivingId: b.survivingId, mergedId: b.mergedId, actorEmail: session.email, reason: b.reason }), { status: 200 });
  } catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/contacts/merge", method: "POST" });

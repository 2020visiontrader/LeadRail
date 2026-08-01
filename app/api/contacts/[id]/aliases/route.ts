import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getContactAliases } from '@/lib/crm';
import { requireSession, errorResponse } from '@/lib/http';
export const dynamic = 'force-dynamic';
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await getContactAliases(params.id, session.accountId)); }
  catch (error) { return errorResponse(error); }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/contacts/[id]/aliases", method: "GET" });

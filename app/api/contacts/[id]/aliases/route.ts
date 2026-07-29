import { NextRequest, NextResponse } from 'next/server';
import { getContactAliases } from '@/lib/crm';
import { requireSession, errorResponse } from '@/lib/http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await getContactAliases(params.id, session.accountId)); }
  catch (error) { return errorResponse(error); }
}

import { NextRequest, NextResponse } from 'next/server';
import { deleteNote } from '@/lib/crm';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try { return NextResponse.json(await deleteNote(params.id, session.accountId)); }
  catch (error) { return errorResponse(error); }
}

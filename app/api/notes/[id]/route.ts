import { NextRequest, NextResponse } from 'next/server';
import { deleteNote } from '@/lib/crm';
import { requireAuth, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try { return NextResponse.json(await deleteNote(params.id)); }
  catch (error) { return errorResponse(error); }
}

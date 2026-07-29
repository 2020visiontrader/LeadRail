import { NextRequest, NextResponse } from 'next/server';
import { getContact, updateContact, deleteContact } from '@/lib/db';
import { requireSession, errorResponse } from '@/lib/http';
import { validateContactPatch } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json(await getContact(params.id, session.accountId));
  } catch (error) {
    return errorResponse(error, 404, 'Contact not found');
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const { ok, errors, value } = validateContactPatch(body);
    if (!ok) return NextResponse.json({ error: 'Validation failed', details: errors }, { status: 400 });
    if (Object.keys(value).length === 0) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    return NextResponse.json(await updateContact(params.id, session.accountId, value));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json(await deleteContact(params.id, session.accountId));
  } catch (error) {
    return errorResponse(error);
  }
}

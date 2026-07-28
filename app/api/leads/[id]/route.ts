import { NextRequest, NextResponse } from 'next/server';
import { getContact, updateContact, deleteContact } from '@/lib/db';
import { requireAuth, errorResponse } from '@/lib/http';
import { validateContactPatch } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json(await getContact(params.id));
  } catch (error) {
    return errorResponse(error, 404, 'Contact not found');
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json();
    const { ok, errors, value } = validateContactPatch(body);
    if (!ok) return NextResponse.json({ error: 'Validation failed', details: errors }, { status: 400 });
    if (Object.keys(value).length === 0) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    return NextResponse.json(await updateContact(params.id, value));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await deleteContact(params.id));
  } catch (error) {
    return errorResponse(error);
  }
}

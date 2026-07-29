import { NextRequest, NextResponse } from 'next/server';
import { tagsForContact, addTagToContact, removeTagFromContact } from '@/lib/tags';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json({ tags: await tagsForContact(session.accountId, params.id) });
  } catch (e: any) {
    if (String(e?.message).includes('not found')) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return errorResponse(e);
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    if (!body?.tagId && !body?.name) return badRequest('tagId or name is required');
    const res = await addTagToContact(session.accountId, params.id, { tagId: body.tagId, name: body.name, color: body.color });
    return NextResponse.json(res);
  } catch (e: any) {
    if (String(e?.message).includes('not found')) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return errorResponse(e);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const tagId = request.nextUrl.searchParams.get('tagId');
    if (!tagId) return badRequest('tagId is required');
    return NextResponse.json(await removeTagFromContact(session.accountId, params.id, tagId));
  } catch (e: any) {
    if (String(e?.message).includes('not found')) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return errorResponse(e);
  }
}

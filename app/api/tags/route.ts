import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { listTags, upsertTag, deleteTag } from '@/lib/tags';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json({ tags: await listTags(session.accountId) });
  } catch (e) {
    return errorResponse(e);
  }
}

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    if (!body?.name) return badRequest('name is required');
    return NextResponse.json(await upsertTag(session.accountId, String(body.name), body.color));
  } catch (e) {
    return errorResponse(e);
  }
}

async function DELETE__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) return badRequest('id is required');
    return NextResponse.json(await deleteTag(session.accountId, id));
  } catch (e: any) {
    if (String(e?.message).includes('not found')) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/tags", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/tags", method: "POST" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/tags", method: "DELETE" });

import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getSegment, updateSegment, deleteSegment } from '@/lib/segments/store';

export const dynamic = 'force-dynamic';

// GET /api/segments/:id — fetch one segment (account-scoped).
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const segment = await getSegment(session.accountId, params.id);
    if (!segment) return badRequest('unknown segment');
    return NextResponse.json(segment);
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH /api/segments/:id — update name/description/filters. Ownership
// enforced inside updateSegment (WHERE account_id = session).
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const segment = await updateSegment(session.accountId, params.id, {
      name: body?.name !== undefined ? String(body.name) : undefined,
      description: body?.description !== undefined ? String(body.description) : undefined,
      filters: Array.isArray(body?.filters) ? body.filters : undefined,
    });
    return NextResponse.json(segment);
  } catch (e: any) {
    if (e?.message === 'segment not found') return badRequest('unknown segment');
    if (e?.message && /field|op|value/i.test(e.message)) return badRequest(e.message);
    return errorResponse(e);
  }
}

// DELETE /api/segments/:id
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json(await deleteSegment(session.accountId, params.id));
  } catch (e: any) {
    if (e?.message === 'segment not found') return badRequest('unknown segment');
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/segments/[id]', method: 'GET' });
export const PATCH = withApi(PATCH__impl as any, { route: '/api/segments/[id]', method: 'PATCH' });
export const DELETE = withApi(DELETE__impl as any, { route: '/api/segments/[id]', method: 'DELETE' });

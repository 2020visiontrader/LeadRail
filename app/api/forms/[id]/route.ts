import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getForm, updateForm, deleteForm } from '@/lib/forms/store';

export const dynamic = 'force-dynamic';

// GET /api/forms/:id — fetch one form (account-scoped).
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const form = await getForm(session.accountId, params.id);
    if (!form) return badRequest('unknown form');
    return NextResponse.json(form);
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH /api/forms/:id — update name/fields/redirect_url/enabled. Ownership
// enforced inside updateForm (WHERE account_id = session).
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const form = await updateForm(session.accountId, params.id, {
      name: body?.name !== undefined ? String(body.name) : undefined,
      fields: Array.isArray(body?.fields) ? body.fields : undefined,
      redirect_url: body?.redirect_url !== undefined ? (body.redirect_url ? String(body.redirect_url) : null) : undefined,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : undefined,
    });
    return NextResponse.json(form);
  } catch (e: any) {
    if (e?.message === 'form not found') return badRequest('unknown form');
    return errorResponse(e);
  }
}

// DELETE /api/forms/:id
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json(await deleteForm(session.accountId, params.id));
  } catch (e: any) {
    if (e?.message === 'form not found') return badRequest('unknown form');
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/forms/[id]', method: 'GET' });
export const PATCH = withApi(PATCH__impl as any, { route: '/api/forms/[id]', method: 'PATCH' });
export const DELETE = withApi(DELETE__impl as any, { route: '/api/forms/[id]', method: 'DELETE' });

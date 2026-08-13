import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getPersona, updatePersona, deletePersona } from '@/lib/agent/personas';

export const dynamic = 'force-dynamic';

// GET /api/personas/:id — fetch a single persona owned by this account.
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const persona = await getPersona(session.accountId, params.id);
    if (!persona) return badRequest('unknown persona');
    return NextResponse.json(persona);
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH /api/personas/:id — update any subset of fields. Setting
// is_coordinator=true unsets any other enabled coordinator for this account.
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const persona = await updatePersona(session.accountId, params.id, {
      name: body?.name !== undefined ? String(body.name) : undefined,
      role: body?.role !== undefined ? (body.role ? String(body.role) : null) : undefined,
      instructions: typeof body?.instructions === 'string' ? body.instructions : undefined,
      model_id: body?.model_id !== undefined ? (body.model_id ? String(body.model_id) : null) : undefined,
      tone: body?.tone !== undefined ? (body.tone ? String(body.tone) : null) : undefined,
      avatar: body?.avatar !== undefined ? (body.avatar ? String(body.avatar) : null) : undefined,
      is_coordinator: body?.is_coordinator !== undefined ? Boolean(body.is_coordinator) : undefined,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : undefined,
      sort_order: body?.sort_order !== undefined && Number.isFinite(body.sort_order) ? Number(body.sort_order) : undefined,
    });
    return NextResponse.json(persona);
  } catch (e: any) {
    if (e?.message === 'persona not found') return badRequest('unknown persona');
    return errorResponse(e);
  }
}

// DELETE /api/personas/:id — hard delete, matching the local convention for
// account-scoped config rows (e.g. ai_providers) rather than CRM/lead data,
// which uses soft-delete.
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json(await deletePersona(session.accountId, params.id));
  } catch (e: any) {
    if (e?.message === 'persona not found') return badRequest('unknown persona');
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/personas/[id]', method: 'GET' });
export const PATCH = withApi(PATCH__impl as any, { route: '/api/personas/[id]', method: 'PATCH' });
export const DELETE = withApi(DELETE__impl as any, { route: '/api/personas/[id]', method: 'DELETE' });

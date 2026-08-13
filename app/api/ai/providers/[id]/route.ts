import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { updateProvider, deleteProvider } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';

// PATCH /api/ai/providers/:id — update name/base_url/api_key/enabled. Account
// ownership is enforced inside updateProvider (WHERE account_id = session).
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const provider = await updateProvider(session.accountId, params.id, {
      name: body?.name !== undefined ? String(body.name) : undefined,
      base_url: body?.base_url !== undefined ? (body.base_url ? String(body.base_url) : null) : undefined,
      api_key: body?.api_key ? String(body.api_key) : undefined,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : undefined,
    });
    const { api_key_encrypted, ...safe } = provider as any;
    return NextResponse.json({ ...safe, has_key: Boolean(api_key_encrypted) });
  } catch (e: any) {
    if (e?.message === 'provider not found') return badRequest('unknown provider');
    return errorResponse(e);
  }
}

// DELETE /api/ai/providers/:id — cascades to its models (FK ON DELETE CASCADE).
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json(await deleteProvider(session.accountId, params.id));
  } catch (e: any) {
    if (e?.message === 'provider not found') return badRequest('unknown provider');
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const PATCH = withApi(PATCH__impl as any, { route: "/api/ai/providers/[id]", method: "PATCH" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/ai/providers/[id]", method: "DELETE" });

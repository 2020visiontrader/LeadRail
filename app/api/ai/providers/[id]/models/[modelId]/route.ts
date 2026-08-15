import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { updateModel, removeModel, type ModelTier } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';

const VALID_TIERS: ModelTier[] = ['fast', 'balanced', 'heavy'];

// PATCH /api/ai/providers/:id/models/:modelId — update label/tier/good/reliable/enabled.
// The :id (provider) segment is not used for the query itself — ownership is
// re-derived from the model's own provider->account_id join inside updateModel,
// which is the authoritative check (a mismatched :id in the URL is harmless).
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string; modelId: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const tier = body?.tier ? String(body.tier) as ModelTier : undefined;
    if (tier && !VALID_TIERS.includes(tier)) return badRequest(`tier must be one of: ${VALID_TIERS.join(', ')}`);
    const model = await updateModel(session.accountId, params.modelId, {
      label: body?.label !== undefined ? (body.label ? String(body.label) : null) : undefined,
      tier,
      good: Array.isArray(body?.good) ? body.good.map(String) : undefined,
      reliable: body?.reliable !== undefined ? Boolean(body.reliable) : undefined,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : undefined,
    });
    return NextResponse.json(model);
  } catch (e: any) {
    if (e?.message === 'unknown model') return badRequest('unknown model');
    return errorResponse(e);
  }
}

// DELETE /api/ai/providers/:id/models/:modelId
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string; modelId: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json(await removeModel(session.accountId, params.modelId));
  } catch (e: any) {
    if (e?.message === 'unknown model') return badRequest('unknown model');
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const PATCH = withApi(PATCH__impl as any, { route: "/api/ai/providers/[id]/models/[modelId]", method: "PATCH" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/ai/providers/[id]/models/[modelId]", method: "DELETE" });

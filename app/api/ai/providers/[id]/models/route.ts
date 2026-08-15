import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { listModels, addModel, type ModelTier } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';

const VALID_TIERS: ModelTier[] = ['fast', 'balanced', 'heavy'];

// GET /api/ai/providers/:id/models — models for one provider (account-scoped).
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json({ models: await listModels(session.accountId, params.id) });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/ai/providers/:id/models — add a model to this provider.
async function POST__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const modelId = String(body?.model_id || '').trim();
    if (!modelId) return badRequest('model_id is required');
    const tier = body?.tier ? String(body.tier) as ModelTier : undefined;
    if (tier && !VALID_TIERS.includes(tier)) return badRequest(`tier must be one of: ${VALID_TIERS.join(', ')}`);
    const model = await addModel(session.accountId, params.id, {
      model_id: modelId,
      label: body?.label ? String(body.label) : null,
      tier,
      good: Array.isArray(body?.good) ? body.good.map(String) : undefined,
      reliable: body?.reliable !== undefined ? Boolean(body.reliable) : undefined,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : undefined,
    });
    return NextResponse.json(model, { status: 201 });
  } catch (e: any) {
    if (e?.message === 'unknown provider') return badRequest('unknown provider');
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/ai/providers/[id]/models", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/ai/providers/[id]/models", method: "POST" });

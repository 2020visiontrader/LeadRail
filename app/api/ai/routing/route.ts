import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getRouting, setRouting } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';

// GET /api/ai/routing — this account's active model + fallback chain
// (null when nothing has been configured yet — router.ts treats that as
// "use the hardcoded ladder").
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json({ routing: await getRouting(session.accountId) });
  } catch (e) {
    return errorResponse(e);
  }
}

// PUT /api/ai/routing — set the active model and/or reorder the fallback
// chain. Both fields optional/independent; each ai_models id is verified to
// belong to this account before being stored.
async function PUT__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    if (body?.active_model_id !== undefined && body.active_model_id !== null && typeof body.active_model_id !== 'string') {
      return badRequest('active_model_id must be a string id or null');
    }
    if (body?.fallback_chain !== undefined && !Array.isArray(body.fallback_chain)) {
      return badRequest('fallback_chain must be an array of model ids');
    }
    const routing = await setRouting(session.accountId, {
      active_model_id: body?.active_model_id !== undefined ? body.active_model_id : undefined,
      fallback_chain: Array.isArray(body?.fallback_chain) ? body.fallback_chain.map(String) : undefined,
    });
    return NextResponse.json(routing);
  } catch (e: any) {
    if (String(e?.message || '').includes('does not belong')) return badRequest(e.message);
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/ai/routing", method: "GET" });
export const PUT = withApi(PUT__impl as any, { route: "/api/ai/routing", method: "PUT" });

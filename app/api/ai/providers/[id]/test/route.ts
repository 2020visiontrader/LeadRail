import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { listModels, testConnection } from '@/lib/ai/providers';
import { supabase } from '@/lib/db';

export const dynamic = 'force-dynamic';

// POST /api/ai/providers/:id/test — cheap connectivity probe for one model on
// this provider (body: { modelId? }). Defaults to the provider's first
// enabled model if modelId is omitted. Never counted as billed AI usage.
async function POST__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json().catch(() => ({}));
    const { data: provider, error: provErr } = await supabase
      .from('ai_providers')
      .select('*')
      .eq('id', params.id)
      .eq('account_id', session.accountId)
      .maybeSingle();
    if (provErr) throw provErr;
    if (!provider) return badRequest('unknown provider');

    const models = await listModels(session.accountId, params.id);
    const model = body?.modelId ? models.find((m) => m.id === body.modelId) : models.find((m) => m.enabled) || models[0];
    if (!model) return badRequest('this provider has no models to test — add one first');

    const result = await testConnection({ provider, model });
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/ai/providers/[id]/test", method: "POST" });

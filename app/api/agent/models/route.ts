import { withApi, requireSession, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { listSelectableModels } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';

// GET /api/agent/models — the account's selectable models for the composer's
// model picker (mirrors the Claude Code UI's model dropdown). Enabled
// ai_models rows joined to their enabled ai_providers row, scoped to the
// session's account only — never another account's configuration.
//
// A pick from this list is a PREFERENCE, not a pin: see the precedence
// comment in lib/agent/loop.ts next to RunAgentInput.modelId. The router's
// fallback chain (lib/ai/providers.ts resolveChain) still runs behind it.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const models = await listSelectableModels(session.accountId);
    return NextResponse.json({ models });
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/agent/models', method: 'GET' });

import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { listProviders, createProvider, type ProviderKind } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';

const VALID_KINDS: ProviderKind[] = ['anthropic', 'zoask', 'opencode', 'nim', 'gemini', 'custom'];

// GET /api/ai/providers — list this account's providers. Keys are always
// masked (has_key + key_preview only; api_key_encrypted never leaves the DB).
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ providers: [] });
  try {
    const providers = await listProviders(session.accountId);
    return NextResponse.json({ providers });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/ai/providers — create a provider. account_id always comes from
// the session, never the client body.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const name = String(body?.name || '').trim();
    const kind = String(body?.kind || '') as ProviderKind;
    if (!name) return badRequest('name is required');
    if (!VALID_KINDS.includes(kind)) return badRequest(`kind must be one of: ${VALID_KINDS.join(', ')}`);
    const provider = await createProvider(session.accountId, {
      name,
      kind,
      base_url: body?.base_url ? String(body.base_url) : null,
      api_key: body?.api_key ? String(body.api_key) : null,
      enabled: body?.enabled !== false,
    });
    const { api_key_encrypted, ...safe } = provider as any;
    return NextResponse.json({ ...safe, has_key: Boolean(api_key_encrypted) }, { status: 201 });
  } catch (e: any) {
    if (e?.code === 'vault_not_configured') return NextResponse.json({ error: e.message }, { status: 503 });
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/ai/providers", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/ai/providers", method: "POST" });
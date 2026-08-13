import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { listPersonas, createPersona } from '@/lib/agent/personas';

export const dynamic = 'force-dynamic';

// GET /api/personas — list this account's persona roster, ordered for the UI.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ personas: [] });
  try {
    const personas = await listPersonas(session.accountId);
    return NextResponse.json({ personas });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/personas — create a persona. account_id always comes from the
// session, never the client body. Setting is_coordinator=true on create
// unsets any other enabled coordinator for this account (see
// lib/agent/personas.ts clearOtherCoordinators).
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const name = String(body?.name || '').trim();
    if (!name) return badRequest('name is required');
    const persona = await createPersona(session.accountId, {
      name,
      role: body?.role ? String(body.role) : null,
      instructions: typeof body?.instructions === 'string' ? body.instructions : '',
      model_id: body?.model_id ? String(body.model_id) : null,
      tone: body?.tone ? String(body.tone) : null,
      avatar: body?.avatar ? String(body.avatar) : null,
      is_coordinator: Boolean(body?.is_coordinator),
      enabled: body?.enabled !== false,
      sort_order: Number.isFinite(body?.sort_order) ? Number(body.sort_order) : 0,
    });
    return NextResponse.json(persona, { status: 201 });
  } catch (e: any) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/personas', method: 'GET' });
export const POST = withApi(POST__impl as any, { route: '/api/personas', method: 'POST' });

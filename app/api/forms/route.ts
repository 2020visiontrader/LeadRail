import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { listForms, createForm } from '@/lib/forms/store';

export const dynamic = 'force-dynamic';

// GET /api/forms — list this account's forms.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ forms: [] });
  try {
    const forms = await listForms(session.accountId);
    return NextResponse.json({ forms });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/forms — create a form. account_id always comes from the
// session, never the client body.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const name = String(body?.name || '').trim();
    if (!name) return badRequest('name is required');
    const form = await createForm(session.accountId, {
      name,
      fields: Array.isArray(body?.fields) ? body.fields : undefined,
      redirect_url: body?.redirect_url ? String(body.redirect_url) : undefined,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : undefined,
    });
    return NextResponse.json(form, { status: 201 });
  } catch (e: any) {
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/forms', method: 'GET' });
export const POST = withApi(POST__impl as any, { route: '/api/forms', method: 'POST' });

import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { submitForm } from '@/lib/forms/store';

export const dynamic = 'force-dynamic';

// This route is intentionally PUBLIC — no requireSession — so a form can be
// embedded and submitted from any external site. submitForm() derives
// account_id from the form row itself (never from this request), so a
// public submission can never be attributed to the wrong tenant.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// POST /api/public/forms/:id/submit — { ...fieldData } → { ok, redirect_url }
async function POST__impl(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await submitForm(params.id, body || {});
    return NextResponse.json(result, { headers: CORS_HEADERS });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || 'submission failed' },
      { status: 400, headers: CORS_HEADERS },
    );
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/public/forms/[id]/submit', method: 'POST' });

// Preflight for cross-origin embeds.
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

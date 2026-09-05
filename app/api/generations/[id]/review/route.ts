import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getGeneration, reviewGeneration, resolveGenerationUrl } from '@/lib/generations/store';
export const dynamic = 'force-dynamic';

async function POST__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const b = await request.json().catch(() => ({}));
    if (b?.state !== 'APPROVED' && b?.state !== 'REJECTED') {
      return badRequest('state must be APPROVED or REJECTED');
    }
    // Look the row up scoped to this account FIRST — a generation belonging
    // to another account must read back as "not found", never leak via a
    // review side-effect on someone else's row.
    const existing = await getGeneration(session.accountId, params.id);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const row = await reviewGeneration(session.accountId, params.id, b.state, b.note ?? null);
    return NextResponse.json({ ...row, url: await resolveGenerationUrl(row) });
  } catch (error) { return errorResponse(error); }
}

export const POST = withApi(POST__impl as any, { route: '/api/generations/[id]/review', method: 'POST' });

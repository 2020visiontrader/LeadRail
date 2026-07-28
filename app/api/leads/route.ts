import { NextRequest, NextResponse } from 'next/server';
import { getContacts, createContact } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
import { validateContactInput } from '@/lib/validation';
import { scoreContact } from '@/lib/scoring';
import { triggerSequencesByCondition } from '@/lib/hermes/agent';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const brandId = request.nextUrl.searchParams.get('brandId');
  const page = parseInt(request.nextUrl.searchParams.get('page') || '0', 10);
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '30', 10), 100);
  if (!brandId) return badRequest('brandId is required');
  try {
    const data = await getContacts(brandId, limit, page * limit);
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json();
    const { ok, errors, value } = validateContactInput(body);
    if (!ok) return NextResponse.json({ error: 'Validation failed', details: errors }, { status: 400 });

    if (value.score == null && value.segment) {
      value.score = scoreContact(value.segment, value.title || '');
    }
    const contact = await createContact(value);

    // Fire-and-forget automation triggers; never fail the request on trigger error.
    triggerSequencesByCondition(contact.brand_id, contact.id).catch((e) =>
      console.error('[hermes-trigger]', e?.message || e)
    );
    return NextResponse.json(contact, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

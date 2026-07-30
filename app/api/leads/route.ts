import { NextRequest, NextResponse } from 'next/server';
import { getContacts, createContact, assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { validateContactInput } from '@/lib/validation';
import { scoreContact } from '@/lib/scoring';
import { triggerSequencesByCondition } from '@/lib/hermes/agent';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const brandId = request.nextUrl.searchParams.get('brandId');
  const page = parseInt(request.nextUrl.searchParams.get('page') || '0', 10);
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '30', 10), 100);
  if (!brandId) return badRequest('brandId is required');
  if (!(await assertBrandOwned(brandId, session.accountId))) return badRequest('unknown brandId');
  try {
    const data = await getContacts(session.accountId, brandId, limit, page * limit);
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const { ok, errors, value } = validateContactInput(body);
    if (!ok) return NextResponse.json({ error: 'Validation failed', details: errors }, { status: 400 });
    if (!(await assertBrandOwned(value.brand_id, session.accountId))) return badRequest('unknown brand_id');

    // account_id is authoritative from the session, never the client body.
    value.account_id = session.accountId;
    if (value.score == null && value.segment) {
      value.score = scoreContact(value.segment, value.title || '');
    }
    const contact = await createContact(value);

    triggerSequencesByCondition(contact.brand_id, contact.id).catch((e) =>
      console.error('[hermes-trigger]', e?.message || e)
    );
    // Phase D: data-driven automations + outbound webhook fan-out (best-effort).
    import('@/lib/automations').then(({ evaluateAutomations }) =>
      evaluateAutomations(session.accountId, 'contact.created', { contact })
    ).catch(() => {});
    import('@/lib/webhooks-out').then(({ emitEvent }) =>
      emitEvent(session.accountId, 'contact.created', { contact })
    ).catch(() => {});
    return NextResponse.json(contact, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

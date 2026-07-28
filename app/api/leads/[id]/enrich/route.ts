import { NextRequest, NextResponse } from 'next/server';
import { getContact, updateContact, dbReady } from '@/lib/db';
import { matchPerson, apolloConfigured } from '@/lib/integrations/apollo';
import { computeFitVerdict } from '@/lib/enrichment';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// POST /api/leads/:id/enrich
// Deepens a single contact via Apollo People Match, computes a fit verdict,
// and persists { enriched, enrichment_status, fit_verdict, score, ...found fields }.
export async function POST(request: NextRequest, ctx: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  if (!dbReady()) return badRequest('database not connected');

  const id = ctx.params.id;
  let contact: any;
  try {
    contact = await getContact(id);
  } catch (error) {
    return errorResponse(error, 404, 'contact not found');
  }

  if (!apolloConfigured()) {
    // No enrichment provider: still compute a base verdict so the UI isn't dead.
    const fit = computeFitVerdict(contact, null);
    try {
      const updated = await updateContact(id, {
        fit_verdict: fit.verdict,
        score: fit.score,
        enrichment_status: 'none',
        enriched: { verdict_reasons: fit.reasons, provider: null },
      });
      return NextResponse.json(
        { contact: updated, fit, code: 'not_configured', connect: 'APOLLO_API_KEY' },
        { status: 200 }
      );
    } catch (error) {
      return errorResponse(error);
    }
  }

  try {
    const enr = await matchPerson({
      email: contact.email,
      linkedin_url: contact.linkedin_url,
      name: contact.name,
      company: contact.company,
    });
    const fit = computeFitVerdict(contact, enr);
    const updates: Record<string, any> = {
      enriched: {
        ...enr,
        verdict_reasons: fit.reasons,
        provider: 'apollo',
        enriched_at: new Date().toISOString(),
      },
      enrichment_status: 'done',
      fit_verdict: fit.verdict,
      score: fit.score,
    };
    if (enr.title && !contact.title) updates.title = enr.title;
    if (enr.organization?.name && !contact.company) updates.company = enr.organization.name;
    if (enr.linkedin_url && !contact.linkedin_url) updates.linkedin_url = enr.linkedin_url;
    if (enr.email && /@locked\.apollo$/.test(contact.email || '')) updates.email = enr.email;

    const updated = await updateContact(id, updates);
    return NextResponse.json({ contact: updated, fit });
  } catch (error: any) {
    // Mark the failure so the UI can show it, then surface a clean error.
    await updateContact(id, { enrichment_status: 'failed' }).catch(() => {});
    if (error?.code === 'auth') return errorResponse(error, 401, 'Apollo rejected the API key');
    return errorResponse(error, 502, 'Apollo enrichment failed');
  }
}

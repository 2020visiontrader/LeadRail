import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getContact, updateContact, dbReady } from '@/lib/db';
import { matchPerson, apolloConfigured } from '@/lib/integrations/apollo';
import { computeFitVerdict } from '@/lib/enrichment';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// POST /api/leads/:id/enrich
async function POST__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error: authErr } = await requireSession(request);
  if (authErr) return authErr;
  if (!dbReady()) return badRequest('database not connected');

  const id = ctx.params.id;
  const accountId = session.accountId;
  let contact: any;
  try {
    contact = await getContact(id, accountId);
  } catch (error) {
    return errorResponse(error, 404, 'contact not found');
  }

  if (!apolloConfigured()) {
    const fit = computeFitVerdict(contact, null);
    try {
      const updated = await updateContact(id, accountId, {
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
    // Apollo person id is captured at import (enriched.apollo_id) and also embedded
    // in the locked-email localpart (`<id>@locked.apollo`). Passing it lets Apollo
    // reveal the exact person; without it, a masked preview never unlocks.
    const lockedLocalPart =
      typeof contact.email === 'string' && /@locked\.apollo$/.test(contact.email)
        ? contact.email.split('@')[0]
        : null;
    const apolloId = contact?.enriched?.apollo_id || lockedLocalPart || null;
    const enr = await matchPerson({
      id: apolloId,
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
    // Un-mask the name once revealed: preview names are obfuscated ("Andrew Ja***n").
    const revealedName = (enr as any)?.raw?.name as string | undefined;
    if (revealedName && /\*/.test(contact.name || '')) updates.name = revealedName;

    const updated = await updateContact(id, accountId, updates);
    return NextResponse.json({ contact: updated, fit });
  } catch (error: any) {
    await updateContact(id, accountId, { enrichment_status: 'failed' }).catch(() => {});
    if (error?.code === 'auth') return errorResponse(error, 401, 'Apollo rejected the API key');
    return errorResponse(error, 502, 'Apollo enrichment failed');
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/leads/[id]/enrich", method: "POST" });

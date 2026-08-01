import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase, dbReady, assertBrandOwned } from '@/lib/db';
import { enqueuePersonEnrichment } from '@/lib/enrichment-jobs';
import { apolloConfigured } from '@/lib/integrations/apollo';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// POST /api/leads/enrich/bulk
//   body: { contactIds?: string[], brandId?: string }
// Queues async person-enrichment jobs (Phase C #16/#17). Either pass explicit
// contactIds, or a brandId to enqueue every not-yet-enriched contact in it.
// Jobs are drained by the hermes tick; the unique live-job index dedupes so a
// contact is never enriched twice concurrently (no double-spend).
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  if (!apolloConfigured()) {
    return NextResponse.json({ error: 'Apollo is not connected', code: 'not_configured', connect: 'APOLLO_API_KEY' }, { status: 409 });
  }

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const accountId = session.accountId;
  let ids: string[] = Array.isArray(body?.contactIds) ? body.contactIds.filter((x: any) => typeof x === 'string') : [];

  if (!ids.length && body?.brandId) {
    if (!(await assertBrandOwned(body.brandId, accountId))) return badRequest('unknown brandId');
    const { data } = await supabase
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('brand_id', body.brandId)
      .is('deleted_at', null)
      .neq('enrichment_status', 'done')
      .limit(500);
    ids = (data || []).map((c: any) => c.id);
  }
  if (!ids.length) return badRequest('provide contactIds[] or a brandId with enrichable contacts');

  // Only enqueue contacts that actually belong to this account (scoping guard).
  const { data: owned } = await supabase
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .in('id', ids.slice(0, 500));
  const ownedIds = (owned || []).map((c: any) => c.id);

  let queued = 0;
  let skipped = 0;
  for (const cid of ownedIds) {
    try {
      const res = await enqueuePersonEnrichment(accountId, cid);
      if (res.queued) { queued++; await supabase.from('contacts').update({ enrichment_status: 'pending' }).eq('id', cid).eq('account_id', accountId); }
      else skipped++;
    } catch { skipped++; }
  }
  return NextResponse.json({ queued, skipped, requested: ids.length }, { status: 202 });
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/leads/enrich/bulk", method: "POST" });

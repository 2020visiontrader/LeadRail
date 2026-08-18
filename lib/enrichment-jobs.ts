// Async enrichment jobs (Phase C, item 17).
// Enrichment moves off the request path onto a job row drained by the same
// hermes tick that runs sequences. Benefits: a slow/failed Apollo call can't
// block an HTTP request, retries are bounded, and the unique live-job index
// stops the same contact being enriched twice concurrently (no double-spend).

import { supabase } from '@/lib/db';
import { matchPerson, enrichOrganization, apolloConfigured } from '@/lib/integrations/apollo';
import { computeFitVerdict } from '@/lib/enrichment';

export interface EnqueueResult { id: string | null; queued: boolean; reason?: string }

/**
 * Queue a person-enrichment job for a contact. Idempotent: the partial unique
 * index (status in pending|running) makes a duplicate insert a no-op, so this
 * safely returns the existing in-flight job instead of erroring.
 */
export async function enqueuePersonEnrichment(accountId: string, contactId: string): Promise<EnqueueResult> {
  const { data, error } = await supabase
    .from('enrichment_jobs')
    .insert([{ account_id: accountId, contact_id: contactId, kind: 'person', provider: 'apollo' }])
    .select('id')
    .single();
  if (error) {
    // 23505 = unique_violation → a live job already exists; treat as already-queued.
    if ((error as any).code === '23505') return { id: null, queued: false, reason: 'already in flight' };
    throw error;
  }
  return { id: data.id, queued: true };
}

/** Queue a company-enrichment job (firmographics via Apollo org enrich). */
export async function enqueueCompanyEnrichment(accountId: string, companyId: string): Promise<EnqueueResult> {
  const { data, error } = await supabase
    .from('enrichment_jobs')
    .insert([{ account_id: accountId, company_id: companyId, kind: 'company', provider: 'apollo' }])
    .select('id')
    .single();
  if (error) {
    if ((error as any).code === '23505') return { id: null, queued: false, reason: 'already in flight' };
    throw error;
  }
  return { id: data.id, queued: true };
}

async function runPersonJob(job: any): Promise<void> {
  const { data: contact } = await supabase.from('contacts').select('*').eq('id', job.contact_id).single();
  if (!contact) throw new Error('contact gone');
  // Budget gate (Packet D1): matchPerson() now asserts the account's spend
  // budget before calling Apollo. job.account_id is stamped at enqueue time
  // (enqueuePersonEnrichment above) — server-derived, never client-supplied.
  const enr = await matchPerson(job.account_id, {
    email: contact.email,
    linkedin_url: contact.linkedin_url,
    name: contact.name,
    company: contact.company,
  });
  const fit = computeFitVerdict(contact, enr);
  const updates: Record<string, any> = {
    enriched: { ...enr, verdict_reasons: fit.reasons, provider: 'apollo', enriched_at: new Date().toISOString() },
    enrichment_status: 'done',
    fit_verdict: fit.verdict,
    score: fit.score,
  };
  if (enr.title && !contact.title) updates.title = enr.title;
  if (enr.organization?.name && !contact.company) updates.company = enr.organization.name;
  if (enr.linkedin_url && !contact.linkedin_url) updates.linkedin_url = enr.linkedin_url;
  if (enr.email && /@locked\.apollo$/.test(contact.email || '')) updates.email = enr.email;
  await supabase.from('contacts').update(updates).eq('id', contact.id);
}

async function runCompanyJob(job: any): Promise<void> {
  const { data: company } = await supabase.from('companies').select('*').eq('id', job.company_id).single();
  if (!company) throw new Error('company gone');
  const org = await enrichOrganization(job.account_id, { domain: company.domain || company.website, name: company.name });
  if (!org) throw new Error('no org match');
  const updates: Record<string, any> = {
    industry: company.industry || org.industry || null,
    website: company.website || org.website_url || null,
    domain: company.domain || org.domain || null,
    linkedin_url: company.linkedin_url || org.linkedin_url || null,
    location: company.location || org.location || null,
    size: company.size || (org.estimated_num_employees != null ? String(org.estimated_num_employees) : null),
    enriched: { ...org, provider: 'apollo', enriched_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  };
  await supabase.from('companies').update(updates).eq('id', company.id);
}

/**
 * Drain due enrichment jobs. Called from the hermes tick alongside sequences.
 * Atomic claim (claim_enrichment_jobs) prevents two ticks working the same job;
 * a failed job is marked failed (bounded by attempts) so it won't spin forever.
 */
export async function processEnrichmentJobs(limit = 10): Promise<{ processed: number; failed: number; considered: number }> {
  if (!apolloConfigured()) return { processed: 0, failed: 0, considered: 0 };

  const claimId = (globalThis.crypto?.randomUUID?.() as string) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let jobs: any[] = [];
  const claimed = await supabase.rpc('claim_enrichment_jobs', { p_limit: limit, p_claim: claimId, p_lock_seconds: 300 });
  if (claimed.error) {
    // Fallback if 011 isn't applied yet: plain select of pending jobs.
    const { data } = await supabase
      .from('enrichment_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit);
    jobs = data || [];
  } else {
    jobs = claimed.data || [];
  }
  if (!jobs.length) return { processed: 0, failed: 0, considered: 0 };

  let processed = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      if (job.kind === 'company') await runCompanyJob(job);
      else await runPersonJob(job);
      await supabase.from('enrichment_jobs').update({
        status: 'done', claim_id: null, locked_until: null, error: null, updated_at: new Date().toISOString(),
      }).eq('id', job.id);
      processed++;
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 300);
      // Give up after 3 attempts; otherwise leave it to retry on the next tick.
      const giveUp = (job.attempts ?? 1) >= 3;
      await supabase.from('enrichment_jobs').update({
        status: giveUp ? 'failed' : 'pending',
        claim_id: null,
        locked_until: null,
        error: msg,
        updated_at: new Date().toISOString(),
      }).eq('id', job.id);
      if (job.kind === 'person' && giveUp) {
        await supabase.from('contacts').update({ enrichment_status: 'failed' }).eq('id', job.contact_id).then(() => {}, () => {});
      }
      failed++;
    }
  }
  return { processed, failed, considered: jobs.length };
}

import { supabase } from '@/lib/db';
import { sendOutreachEmail, SuppressedError } from '@/lib/outreach';
import { createActivity } from '@/lib/crm';
import { normalizeBusinessHours, nextBusinessTime, type BusinessHours } from '@/lib/business-hours';
import { classifyReply } from '@/lib/reply-classifier';

// Scheduling jitter (± up to this many ms) so follow-ups don't fire in a
// detectable burst — cheap deliverability hygiene.
const JITTER_MS = 12 * 60 * 1000;
function jitter(): number {
  return Math.floor((Math.random() - 0.5) * 2 * JITTER_MS);
}

/**
 * Next run time = now + delay + jitter, then shifted into the business-hours
 * window when one is configured (Phase C #7). bh null → 24/7 (old behaviour).
 */
function computeNextRun(delayHours: number, bh: BusinessHours | null): string {
  const base = new Date(Date.now() + delayHours * 3600 * 1000 + jitter());
  return nextBusinessTime(base, bh).toISOString();
}

/**
 * Reply-stop (gap #1): mark active enrollments 'replied' when the contact has
 * sent an inbound message after the enrollment started. Cancels the pending
 * next step for free — the claim never picks a non-'active' row. Phase C:
 * classify the reply into a structured `outcome` and credit the sent variant a
 * reply. Best-effort; failures don't block the send loop.
 */
export async function stopRepliedEnrollments(limit = 200): Promise<number> {
  const { data: active } = await supabase
    .from('sequence_enrollments')
    .select('id, contact_id, created_at, last_variant_id')
    .eq('status', 'active')
    .limit(limit);
  if (!active || !active.length) return 0;

  const contactIds = [...new Set(active.map((e) => e.contact_id))];
  const { data: inbound } = await supabase
    .from('inbox_messages')
    .select('contact_id, received_at, body')
    .eq('direction', 'inbound')
    .in('contact_id', contactIds);
  if (!inbound || !inbound.length) return 0;

  // Latest inbound per contact — keep the body so we can classify the outcome.
  const latestReply = new Map<string, { t: number; body: string | null }>();
  for (const m of inbound) {
    if (!m.contact_id) continue;
    const t = new Date(m.received_at || 0).getTime();
    const prev = latestReply.get(m.contact_id);
    if (!prev || t > prev.t) latestReply.set(m.contact_id, { t, body: m.body ?? null });
  }

  const replied = active.filter((e) => {
    const r = latestReply.get(e.contact_id);
    return r && r.t > new Date(e.created_at || 0).getTime();
  });
  if (!replied.length) return 0;

  // Account per replied contact — needed to fire account-scoped automations/webhooks.
  const repliedContactIds = [...new Set(replied.map((e) => e.contact_id))];
  const { data: rc } = await supabase.from('contacts').select('id, account_id, brand_id').in('id', repliedContactIds);
  const acctOf = new Map<string, { account_id: string; brand_id: string | null }>(
    (rc || []).map((c: any) => [c.id, { account_id: c.account_id, brand_id: c.brand_id }]),
  );

  const nowIso = new Date().toISOString();
  await Promise.all(
    replied.map(async (e) => {
      const outcome = classifyReply(latestReply.get(e.contact_id)?.body);
      await supabase
        .from('sequence_enrollments')
        .update({ status: 'replied', replied_at: nowIso, last_event: 'replied', outcome })
        .eq('id', e.id);
      if (e.last_variant_id) {
        await supabase.rpc('increment_variant_counter', { p_variant: e.last_variant_id, p_col: 'reply_count' }).then(() => {}, () => {});
      }
      // Phase D: fire automations (trigger 'email.replied') + outbound webhooks.
      const meta = acctOf.get(e.contact_id);
      if (meta?.account_id) {
        const ctx = { contactId: e.contact_id, brandId: meta.brand_id, outcome, enrollmentId: e.id };
        import('@/lib/automations').then(({ evaluateAutomations }) =>
          evaluateAutomations(meta.account_id, 'email.replied', ctx)).catch(() => {});
        import('@/lib/webhooks-out').then(({ emitEvent }) =>
          emitEvent(meta.account_id, 'sequence.replied', ctx)).catch(() => {});
      }
    }),
  );
  return replied.length;
}

// ============================================================
// Sequences module (canonical: 004 tables)
//   sequences → sequence_steps → sequence_enrollments
// sequence_enrollments IS the durable queue: the tick drains rows whose
// next_run_at is due, runs the current step by type, then advances or completes.
// ============================================================

export interface VariantInput {
  label?: string;
  subject?: string | null;
  body?: string | null;
  template_id?: string | null;
  weight?: number;
}

export interface StepInput {
  step_order: number;
  type?: string;                // email | wait | manual | task | branch
  delay_hours?: number;
  template_id?: string | null;
  subject?: string | null;
  body?: string | null;
  variants?: VariantInput[];
}

const STEP_TYPES = new Set(['email', 'wait', 'manual', 'task', 'branch']);

export async function listSequences(brandId: string) {
  const { data, error } = await supabase
    .from('sequences')
    .select('*, sequence_steps(*, sequence_step_variants(*))')
    .eq('brand_id', brandId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getSequence(id: string, accountId?: string) {
  let q = supabase.from('sequences').select('*, sequence_steps(*, sequence_step_variants(*))').eq('id', id);
  if (accountId) q = q.eq('account_id', accountId);
  const { data, error } = await q.single();
  if (error) throw error;
  return data;
}

export async function createSequence(input: {
  account_id: string;
  brand_id: string;
  name: string;
  channel?: string;
  is_active?: boolean;
  business_hours?: any;
  steps?: StepInput[];
}) {
  const { data: seq, error } = await supabase
    .from('sequences')
    .insert([{
      account_id: input.account_id,
      brand_id: input.brand_id,
      name: input.name,
      channel: input.channel ?? 'email',
      is_active: input.is_active ?? false,
      business_hours: normalizeBusinessHours(input.business_hours),
    }])
    .select()
    .single();
  if (error) throw error;

  const steps = (input.steps || []).map((s, i) => ({
    sequence_id: seq.id,
    step_order: s.step_order ?? i,
    type: STEP_TYPES.has(s.type || '') ? s.type : 'email',
    delay_hours: s.delay_hours ?? 0,
    template_id: s.template_id ?? null,
    subject: s.subject ?? null,
    body: s.body ?? null,
  }));
  if (steps.length) {
    const { data: insertedSteps, error: stepErr } = await supabase.from('sequence_steps').insert(steps).select();
    if (stepErr) throw stepErr;

    // Insert A/B variants for steps that declared them (matched back by step_order).
    const variantRows: Record<string, any>[] = [];
    for (const s of input.steps || []) {
      if (!s.variants?.length) continue;
      const parent = (insertedSteps || []).find((r: any) => r.step_order === (s.step_order ?? 0));
      if (!parent) continue;
      for (const v of s.variants) {
        variantRows.push({
          step_id: parent.id,
          label: v.label ?? 'A',
          subject: v.subject ?? null,
          body: v.body ?? null,
          template_id: v.template_id ?? null,
          weight: Math.max(0, v.weight ?? 1),
        });
      }
    }
    if (variantRows.length) {
      const { error: varErr } = await supabase.from('sequence_step_variants').insert(variantRows);
      if (varErr) throw varErr;
    }
  }
  return getSequence(seq.id);
}

export async function updateSequence(id: string, accountId: string, updates: Record<string, any>) {
  const allowed: Record<string, any> = {};
  for (const k of ['name', 'channel', 'is_active']) if (updates[k] != null) allowed[k] = updates[k];
  if (updates.business_hours !== undefined) allowed.business_hours = normalizeBusinessHours(updates.business_hours);
  const { data, error } = await supabase.from('sequences').update(allowed).eq('id', id).eq('account_id', accountId).select().single();
  if (error) throw error;
  return data;
}

export async function deleteSequence(id: string, accountId: string) {
  const { data, error } = await supabase.from('sequences').delete().eq('id', id).eq('account_id', accountId).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('not found');
  return { id, deleted: true };
}

/** Load the effective business-hours window for a sequence (seq override → account default). */
async function resolveBusinessHours(seq: any): Promise<BusinessHours | null> {
  const own = normalizeBusinessHours(seq?.business_hours);
  if (own) return own;
  if (!seq?.account_id) return null;
  const { data: acct } = await supabase.from('accounts').select('business_hours').eq('id', seq.account_id).single();
  return normalizeBusinessHours(acct?.business_hours);
}

/** Enroll contacts into a sequence at step 0, scheduling the first send. */
export async function enrollContacts(sequenceId: string, accountId: string, contactIds: string[]) {
  const seq = await getSequence(sequenceId, accountId);
  const steps = (seq.sequence_steps || []).sort((a: any, b: any) => a.step_order - b.step_order);
  if (!steps.length) throw new Error('sequence has no steps');

  const bh = await resolveBusinessHours(seq);
  const nextRun = computeNextRun(steps[0].delay_hours || 0, bh);

  const rows = contactIds.map((cid) => ({
    sequence_id: sequenceId,
    contact_id: cid,
    current_step: 0,
    status: 'active',
    next_run_at: nextRun,
  }));
  // Upsert so re-enrolling the same contact is a no-op rather than an error.
  const { data, error } = await supabase
    .from('sequence_enrollments')
    .upsert(rows, { onConflict: 'sequence_id,contact_id', ignoreDuplicates: true })
    .select();
  if (error) throw error;
  return data;
}

/**
 * Pick the content to send for a step. When the step has A/B variants, choose
 * one by weight and return its id so the engine can attribute stats to it.
 * Falls back to the step's own subject/body (and template) when there are none.
 */
async function selectStepContent(step: any): Promise<{ subject: string; html: string; variantId: string | null; templateId: string | null }> {
  const variants: any[] = step.sequence_step_variants || [];
  const usable = variants.filter((v) => (v.weight ?? 1) > 0);
  if (usable.length) {
    const total = usable.reduce((s, v) => s + (v.weight ?? 1), 0);
    let r = Math.random() * total;
    let chosen = usable[0];
    for (const v of usable) { r -= v.weight ?? 1; if (r <= 0) { chosen = v; break; } }
    const { subject, html } = await resolveContent(chosen.subject, chosen.body, chosen.template_id);
    return { subject, html, variantId: chosen.id, templateId: chosen.template_id || null };
  }
  const { subject, html } = await resolveContent(step.subject, step.body, step.template_id);
  return { subject, html, variantId: null, templateId: step.template_id || null };
}

async function resolveContent(subj: string | null, body: string | null, templateId: string | null): Promise<{ subject: string; html: string }> {
  let subject = subj || 'Following up';
  let html = body || '';
  if (templateId && (!subj || !body)) {
    const { data: tpl } = await supabase.from('message_templates').select('subject, body').eq('id', templateId).single();
    if (tpl) {
      subject = subj || tpl.subject || 'Following up';
      html = body || tpl.body || '';
    }
  }
  return { subject, html };
}

/**
 * Drain due enrollments. Called from POST /api/hermes/tick (single cron).
 * Runs the current step by type, then advances current_step + next_run_at, or
 * marks the enrollment completed when there are no further steps.
 */
export async function processDueEnrollments(limit = 25) {
  // 1) Reply-stop before claiming so replied contacts drop out of the batch.
  const stopped = await stopRepliedEnrollments().catch(() => 0);

  // 2) Atomically claim due rows. FOR UPDATE SKIP LOCKED (in the DB function)
  //    guarantees a concurrent tick never grabs the same enrollment — fixes the
  //    double-send race. Falls back to a plain select if the function is absent
  //    (migration 009 not yet applied), preserving old behaviour.
  const claimId =
    (globalThis.crypto?.randomUUID?.() as string) ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let due: any[] = [];
  const claimed = await supabase.rpc('claim_due_enrollments', { p_limit: limit, p_claim: claimId, p_lock_seconds: 300 });
  if (claimed.error) {
    const { data } = await supabase
      .from('sequence_enrollments')
      .select('*')
      .eq('status', 'active')
      .lte('next_run_at', new Date().toISOString())
      .order('next_run_at', { ascending: true })
      .limit(limit);
    due = data || [];
  } else {
    due = claimed.data || [];
  }
  if (!due.length) return { processed: 0, considered: 0, stopped, capped: 0 };

  // 3) Resolve contacts (for per-account cap) and precompute per-account
  //    sent-today counts + caps once per tick.
  const contactIds = [...new Set(due.map((e) => e.contact_id))];
  const { data: contacts } = await supabase
    .from('contacts')
    .select('id, account_id')
    .in('id', contactIds);
  const acctOf = new Map<string, string>((contacts || []).map((c: any) => [c.id, c.account_id]));

  const accountIds = [...new Set([...acctOf.values()].filter(Boolean))] as string[];
  const sentToday = new Map<string, number>();
  const capOf = new Map<string, number>();
  if (accountIds.length) {
    const { data: accts } = await supabase.from('accounts').select('id, daily_send_cap').in('id', accountIds);
    for (const a of accts || []) capOf.set(a.id, a.daily_send_cap ?? 500);
    await Promise.all(
      accountIds.map(async (aid) => {
        const { data } = await supabase.rpc('account_sent_today', { p_account: aid });
        sentToday.set(aid, typeof data === 'number' ? data : 0);
      }),
    );
  }

  // Cache resolved business-hours per sequence for this tick.
  const bhCache = new Map<string, BusinessHours | null>();

  let processed = 0;
  let capped = 0;
  for (const enr of due) {
    try {
      const acctId = acctOf.get(enr.contact_id);

      const { data: seq } = await supabase
        .from('sequences')
        .select('*, sequence_steps(*, sequence_step_variants(*))')
        .eq('id', enr.sequence_id)
        .single();
      const steps = (seq?.sequence_steps || []).sort((a: any, b: any) => a.step_order - b.step_order);
      const step = steps[enr.current_step];

      if (!seq?.is_active || !step) {
        await supabase.from('sequence_enrollments')
          .update({ status: 'completed', claim_id: null, locked_until: null })
          .eq('id', enr.id);
        continue;
      }

      if (!bhCache.has(enr.sequence_id)) bhCache.set(enr.sequence_id, await resolveBusinessHours(seq));
      const bh = bhCache.get(enr.sequence_id) ?? null;

      const stepType: string = STEP_TYPES.has(step.type) ? step.type : 'email';
      const nextStep = steps[enr.current_step + 1];
      const advance = async (extra: Record<string, any> = {}) => {
        if (nextStep) {
          await supabase.from('sequence_enrollments').update({
            current_step: enr.current_step + 1,
            next_run_at: computeNextRun(nextStep.delay_hours || 0, bh),
            claim_id: null,
            locked_until: null,
            ...extra,
          }).eq('id', enr.id);
        } else {
          await supabase.from('sequence_enrollments').update({
            status: 'completed', claim_id: null, locked_until: null, ...extra,
          }).eq('id', enr.id);
        }
      };

      // --- Non-email step types: no send, no cap consumption. ---
      if (stepType === 'wait') {
        // wait: pure delay before the next step.
        await advance({ last_event: 'wait' });
        processed++;
        continue;
      }
      if (stepType === 'branch') {
        // Phase D #19: evaluate the step's conditions against the contact and jump.
        // config = { match, conditions[], jumpTo: <step_order>, else: 'continue'|'complete' }.
        const cfg = step.config || {};
        const { data: c } = await supabase
          .from('contacts').select('*').eq('id', enr.contact_id).single();
        const { evaluateConditions } = await import('@/lib/automations');
        const matched = evaluateConditions(cfg, { contact: c, ...(c || {}) });
        if (matched && cfg.jumpTo != null) {
          const target = steps.findIndex((s: any) => s.step_order === cfg.jumpTo);
          const idx = target >= 0 ? target : enr.current_step + 1;
          const jumpStep = steps[idx];
          if (jumpStep) {
            await supabase.from('sequence_enrollments').update({
              current_step: idx,
              next_run_at: computeNextRun(jumpStep.delay_hours || 0, bh),
              claim_id: null, locked_until: null, last_event: 'branch_jump',
            }).eq('id', enr.id);
          } else {
            await supabase.from('sequence_enrollments')
              .update({ status: 'completed', claim_id: null, locked_until: null, last_event: 'branch_end' })
              .eq('id', enr.id);
          }
        } else if (!matched && cfg.else === 'complete') {
          await supabase.from('sequence_enrollments')
            .update({ status: 'completed', claim_id: null, locked_until: null, last_event: 'branch_complete' })
            .eq('id', enr.id);
        } else {
          await advance({ last_event: 'branch_continue' });
        }
        processed++;
        continue;
      }
      if (stepType === 'manual' || stepType === 'task') {
        // Open a human task; `manual` pauses until a person acts, `task` flows on.
        await createActivity({
          account_id: acctId || seq.account_id,
          brand_id: seq.brand_id,
          type: 'task',
          subject: step.subject || `Sequence step ${enr.current_step + 1}: ${seq.name}`,
          body: step.body || null,
          status: 'open',
          due_at: new Date().toISOString(),
          contact_id: enr.contact_id,
        }).catch(() => {});
        if (stepType === 'manual') {
          await supabase.from('sequence_enrollments')
            .update({ status: 'paused', last_event: 'manual_task', claim_id: null, locked_until: null })
            .eq('id', enr.id);
        } else {
          await advance({ last_event: 'task' });
        }
        processed++;
        continue;
      }

      // --- email step: cap check, then send the step (or a variant). ---
      if (acctId) {
        const cap = capOf.get(acctId) ?? 500;
        const used = sentToday.get(acctId) ?? 0;
        if (used >= cap) {
          capped++;
          await supabase.from('sequence_enrollments').update({
            next_run_at: computeNextRun(4, bh),
            claim_id: null,
            locked_until: null,
            last_event: 'capped',
          }).eq('id', enr.id);
          continue;
        }
      }

      const { subject, html, variantId, templateId } = await selectStepContent(step);
      await sendOutreachEmail({
        contactId: enr.contact_id,
        subject,
        html,
        templateId: templateId || undefined,
        accountId: acctId,
        enrollmentId: enr.id,
        stepId: step.id,
      });
      await supabase.rpc('increment_step_counter', { p_step: step.id, p_col: 'sent_count' }).then(() => {}, () => {});
      if (variantId) {
        await supabase.rpc('increment_variant_counter', { p_variant: variantId, p_col: 'sent_count' }).then(() => {}, () => {});
      }
      if (acctId) sentToday.set(acctId, (sentToday.get(acctId) ?? 0) + 1);

      await advance({ last_event: 'sent', last_variant_id: variantId });
      processed++;
    } catch (e: any) {
      // A suppressed contact is a clean skip (complete), not a retryable error.
      if (e instanceof SuppressedError) {
        await supabase.from('sequence_enrollments')
          .update({ status: 'completed', last_event: 'suppressed', claim_id: null, locked_until: null })
          .eq('id', enr.id);
      } else {
        await supabase.from('sequence_enrollments')
          .update({ status: 'paused', last_event: `error: ${String(e?.message || e).slice(0, 200)}`, claim_id: null, locked_until: null })
          .eq('id', enr.id);
      }
    }
  }
  return { processed, considered: due.length, stopped, capped };
}

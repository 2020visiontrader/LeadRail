import { supabase } from '@/lib/db';
import { sendOutreachEmail, SuppressedError } from '@/lib/outreach';

// Scheduling jitter (± up to this many ms) so follow-ups don't fire in a
// detectable burst — cheap deliverability hygiene.
const JITTER_MS = 12 * 60 * 1000;
function jitter(): number {
  return Math.floor((Math.random() - 0.5) * 2 * JITTER_MS);
}
function scheduleNext(delayHours: number): string {
  return new Date(Date.now() + delayHours * 3600 * 1000 + jitter()).toISOString();
}

/**
 * Reply-stop (gap #1): mark active enrollments 'replied' when the contact has
 * sent an inbound message after the enrollment started. Cancels the pending
 * next step for free — the claim never picks a non-'active' row. Best-effort;
 * failures don't block the send loop.
 */
export async function stopRepliedEnrollments(limit = 200): Promise<number> {
  const { data: active } = await supabase
    .from('sequence_enrollments')
    .select('id, contact_id, created_at')
    .eq('status', 'active')
    .limit(limit);
  if (!active || !active.length) return 0;

  const contactIds = [...new Set(active.map((e) => e.contact_id))];
  const { data: inbound } = await supabase
    .from('inbox_messages')
    .select('contact_id, received_at')
    .eq('direction', 'inbound')
    .in('contact_id', contactIds);
  if (!inbound || !inbound.length) return 0;

  const latestReply = new Map<string, number>();
  for (const m of inbound) {
    if (!m.contact_id) continue;
    const t = new Date(m.received_at || 0).getTime();
    latestReply.set(m.contact_id, Math.max(latestReply.get(m.contact_id) || 0, t));
  }

  const replied = active.filter((e) => {
    const r = latestReply.get(e.contact_id);
    return r && r > new Date(e.created_at || 0).getTime();
  });
  if (!replied.length) return 0;

  const nowIso = new Date().toISOString();
  await supabase
    .from('sequence_enrollments')
    .update({ status: 'replied', replied_at: nowIso, last_event: 'replied' })
    .in('id', replied.map((e) => e.id));
  return replied.length;
}

// ============================================================
// Sequences module (canonical: 004 tables)
//   sequences → sequence_steps → sequence_enrollments
// sequence_enrollments IS the durable queue: the tick drains rows whose
// next_run_at is due, sends the current step, then advances or completes.
// ============================================================

export interface StepInput {
  step_order: number;
  delay_hours?: number;
  template_id?: string | null;
  subject?: string | null;
  body?: string | null;
}

export async function listSequences(brandId: string) {
  const { data, error } = await supabase
    .from('sequences')
    .select('*, sequence_steps(*)')
    .eq('brand_id', brandId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getSequence(id: string, accountId?: string) {
  let q = supabase.from('sequences').select('*, sequence_steps(*)').eq('id', id);
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
    }])
    .select()
    .single();
  if (error) throw error;

  const steps = (input.steps || []).map((s, i) => ({
    sequence_id: seq.id,
    step_order: s.step_order ?? i,
    delay_hours: s.delay_hours ?? 0,
    template_id: s.template_id ?? null,
    subject: s.subject ?? null,
    body: s.body ?? null,
  }));
  if (steps.length) {
    const { error: stepErr } = await supabase.from('sequence_steps').insert(steps);
    if (stepErr) throw stepErr;
  }
  return getSequence(seq.id);
}

export async function updateSequence(id: string, accountId: string, updates: Record<string, any>) {
  const allowed: Record<string, any> = {};
  for (const k of ['name', 'channel', 'is_active']) if (updates[k] != null) allowed[k] = updates[k];
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

/** Enroll contacts into a sequence at step 0, scheduling the first send. */
export async function enrollContacts(sequenceId: string, accountId: string, contactIds: string[]) {
  const seq = await getSequence(sequenceId, accountId);
  const steps = (seq.sequence_steps || []).sort((a: any, b: any) => a.step_order - b.step_order);
  if (!steps.length) throw new Error('sequence has no steps');

  const firstDelayMs = (steps[0].delay_hours || 0) * 3600 * 1000;
  const nextRun = new Date(Date.now() + firstDelayMs).toISOString();

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

async function resolveStepContent(step: any): Promise<{ subject: string; html: string }> {
  let subject = step.subject || 'Following up';
  let html = step.body || '';
  if (step.template_id && (!subject || !html)) {
    const { data: tpl } = await supabase
      .from('message_templates')
      .select('subject, body')
      .eq('id', step.template_id)
      .single();
    if (tpl) {
      subject = subject || tpl.subject || 'Following up';
      html = html || tpl.body || '';
    }
  }
  return { subject, html };
}

/**
 * Drain due enrollments. Called from POST /api/hermes/tick (single cron).
 * Sends the current step, then advances current_step + next_run_at, or marks
 * the enrollment completed when there are no further steps.
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

  let processed = 0;
  let capped = 0;
  for (const enr of due) {
    try {
      const acctId = acctOf.get(enr.contact_id);

      // 3a) Per-account daily cap: reschedule (don't drop) when exceeded.
      if (acctId) {
        const cap = capOf.get(acctId) ?? 500;
        const used = sentToday.get(acctId) ?? 0;
        if (used >= cap) {
          capped++;
          await supabase.from('sequence_enrollments').update({
            next_run_at: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
            claim_id: null,
            locked_until: null,
            last_event: 'capped',
          }).eq('id', enr.id);
          continue;
        }
      }

      const { data: seq } = await supabase
        .from('sequences')
        .select('*, sequence_steps(*)')
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

      const { subject, html } = await resolveStepContent(step);
      await sendOutreachEmail({
        contactId: enr.contact_id,
        subject,
        html,
        templateId: step.template_id || undefined,
        accountId: acctId,
        enrollmentId: enr.id,
        stepId: step.id,
      });
      await supabase.rpc('increment_step_counter', { p_step: step.id, p_col: 'sent_count' }).then(() => {}, () => {});
      if (acctId) sentToday.set(acctId, (sentToday.get(acctId) ?? 0) + 1);

      const nextStep = steps[enr.current_step + 1];
      if (nextStep) {
        await supabase.from('sequence_enrollments').update({
          current_step: enr.current_step + 1,
          next_run_at: scheduleNext(nextStep.delay_hours || 0),
          last_event: 'sent',
          claim_id: null,
          locked_until: null,
        }).eq('id', enr.id);
      } else {
        await supabase.from('sequence_enrollments').update({
          status: 'completed',
          last_event: 'sent',
          claim_id: null,
          locked_until: null,
        }).eq('id', enr.id);
      }
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

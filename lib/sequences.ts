import { supabase } from '@/lib/db';
import { sendOutreachEmail } from '@/lib/outreach';

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

export async function getSequence(id: string) {
  const { data, error } = await supabase
    .from('sequences')
    .select('*, sequence_steps(*)')
    .eq('id', id)
    .single();
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

export async function updateSequence(id: string, updates: Record<string, any>) {
  const allowed: Record<string, any> = {};
  for (const k of ['name', 'channel', 'is_active']) if (updates[k] != null) allowed[k] = updates[k];
  const { data, error } = await supabase.from('sequences').update(allowed).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteSequence(id: string) {
  const { error } = await supabase.from('sequences').delete().eq('id', id);
  if (error) throw error;
  return { id, deleted: true };
}

/** Enroll contacts into a sequence at step 0, scheduling the first send. */
export async function enrollContacts(sequenceId: string, contactIds: string[]) {
  const seq = await getSequence(sequenceId);
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
  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabase
    .from('sequence_enrollments')
    .select('*')
    .eq('status', 'active')
    .lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true })
    .limit(limit);
  if (error) throw error;

  let processed = 0;
  for (const enr of due || []) {
    try {
      const { data: seq } = await supabase
        .from('sequences')
        .select('*, sequence_steps(*)')
        .eq('id', enr.sequence_id)
        .single();
      const steps = (seq?.sequence_steps || []).sort((a: any, b: any) => a.step_order - b.step_order);
      const step = steps[enr.current_step];

      if (!seq?.is_active || !step) {
        await supabase.from('sequence_enrollments').update({ status: 'completed' }).eq('id', enr.id);
        continue;
      }

      const { subject, html } = await resolveStepContent(step);
      await sendOutreachEmail({ contactId: enr.contact_id, subject, html, templateId: step.template_id || undefined });

      const nextStep = steps[enr.current_step + 1];
      if (nextStep) {
        await supabase.from('sequence_enrollments').update({
          current_step: enr.current_step + 1,
          next_run_at: new Date(Date.now() + (nextStep.delay_hours || 0) * 3600 * 1000).toISOString(),
          last_event: 'sent',
        }).eq('id', enr.id);
      } else {
        await supabase.from('sequence_enrollments').update({
          status: 'completed',
          last_event: 'sent',
        }).eq('id', enr.id);
      }
      processed++;
    } catch (e: any) {
      await supabase.from('sequence_enrollments')
        .update({ status: 'paused', last_event: `error: ${String(e?.message || e).slice(0, 200)}` })
        .eq('id', enr.id);
    }
  }
  return { processed, considered: due?.length || 0 };
}

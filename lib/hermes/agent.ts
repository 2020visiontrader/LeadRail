import { supabase } from '@/lib/db';
import { HermesSequence, HermesStep } from '@/lib/types';
import { sendOutreachEmail } from '@/lib/outreach';

function delayMinutes(step?: HermesStep): number {
  return step && typeof step.delay === 'number' && step.delay > 0 ? step.delay : 0;
}

function runAtFrom(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export async function createSequence(sequence: Omit<HermesSequence, 'id' | 'created_at'>) {
  const { data, error } = await supabase
    .from('hermes_sequences')
    .insert([{
      brand_id: sequence.brand_id,
      name: sequence.name,
      trigger: sequence.trigger,
      steps: sequence.steps,
      is_active: sequence.is_active ?? true,
    }])
    .select();
  if (error) throw error;
  return data[0];
}

/** Enqueue a sequence's first step for a contact (durable job, not setTimeout). */
export async function enqueueSequence(sequenceId: string, contactId: string) {
  const { data: sequence, error } = await supabase
    .from('hermes_sequences')
    .select('*')
    .eq('id', sequenceId)
    .single();
  if (error) throw error;
  if (!sequence?.is_active) return null;

  const steps: HermesStep[] = sequence.steps || [];
  if (!steps.length) return null;

  const { data, error: jobErr } = await supabase
    .from('hermes_jobs')
    .insert([{
      sequence_id: sequenceId,
      contact_id: contactId,
      step_index: 0,
      run_at: runAtFrom(delayMinutes(steps[0])),
      status: 'pending',
    }])
    .select();
  if (jobErr) throw jobErr;
  return data[0];
}

async function runStep(sequence: any, contactId: string, step: HermesStep) {
  switch (step.action) {
    case 'send_email':
      await sendOutreachEmail({
        contactId,
        subject: step.config?.subject || 'Following up',
        html: step.config?.html,
        templateId: step.config?.templateId,
      });
      break;
    case 'add_tag':
      await supabase.from('contacts').update({ notes: step.config?.tag }).eq('id', contactId);
      break;
    case 'update_score':
      await supabase.rpc('increment_contact_score', {
        contact_id: contactId,
        increment: Number(step.config?.scoreIncrease) || 0,
      });
      break;
    case 'create_task':
      await supabase.from('contact_events').insert([{
        contact_id: contactId,
        event_type: 'task',
        event_data: { title: step.config?.title || 'Follow up' },
      }]);
      break;
  }
}

/**
 * Drain due Hermes jobs. Call from a cron (e.g. Supabase scheduled function
 * or Vercel Cron) hitting POST /api/hermes/tick. Processes one step per job,
 * then enqueues the next step at its scheduled delay.
 */
export async function processDueJobs(limit = 25) {
  const nowIso = new Date().toISOString();
  const { data: jobs, error } = await supabase
    .from('hermes_jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', nowIso)
    .order('run_at', { ascending: true })
    .limit(limit);
  if (error) throw error;

  let processed = 0;
  for (const job of jobs || []) {
    try {
      const { data: sequence } = await supabase
        .from('hermes_sequences')
        .select('*')
        .eq('id', job.sequence_id)
        .single();

      const steps: HermesStep[] = sequence?.steps || [];
      const step = steps[job.step_index];

      if (sequence?.is_active && step) {
        await runStep(sequence, job.contact_id, step);
        const next = steps[job.step_index + 1];
        if (next) {
          await supabase.from('hermes_jobs').insert([{
            sequence_id: job.sequence_id,
            contact_id: job.contact_id,
            step_index: job.step_index + 1,
            run_at: runAtFrom(delayMinutes(next)),
            status: 'pending',
          }]);
        }
      }
      await supabase.from('hermes_jobs').update({ status: 'done' }).eq('id', job.id);
      processed++;
    } catch (e: any) {
      await supabase.from('hermes_jobs')
        .update({ status: 'failed', last_error: String(e?.message || e).slice(0, 500) })
        .eq('id', job.id);
    }
  }
  return { processed, considered: jobs?.length || 0 };
}

/** Evaluate triggers for a contact and enqueue matching active sequences. */
export async function triggerSequencesByCondition(brandId: string, contactId: string) {
  const { data: contact } = await supabase.from('contacts').select('*').eq('id', contactId).single();
  if (!contact) return;

  const { data: sequences } = await supabase
    .from('hermes_sequences')
    .select('*')
    .eq('brand_id', brandId)
    .eq('is_active', true);

  for (const seq of sequences || []) {
    if (seq.trigger === 'new_contact') {
      await enqueueSequence(seq.id, contactId);
    } else if (seq.trigger === 'high_score' && (contact.score ?? 0) >= 80) {
      await enqueueSequence(seq.id, contactId);
    } else if (seq.trigger === 'no_engagement' && contact.status === 'new') {
      const daysSince = (Date.now() - new Date(contact.created_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince >= 7) await enqueueSequence(seq.id, contactId);
    }
  }
}

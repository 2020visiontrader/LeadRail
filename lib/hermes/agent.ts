import { supabase } from '@/lib/db';

export interface HermesSequence {
  id: string;
  brandId: string;
  name: string;
  trigger: 'new_contact' | 'high_score' | 'no_engagement' | 'manual';
  steps: HermesStep[];
  isActive: boolean;
}

export interface HermesStep {
  order: number;
  action: 'send_email' | 'add_tag' | 'update_score' | 'create_task';
  config: Record<string, any>;
  delay?: number; // minutes
}

export async function createSequence(sequence: Omit<HermesSequence, 'id'>) {
  const { data, error } = await supabase
    .from('hermes_sequences')
    .insert([{ ...sequence, created_at: new Date() }])
    .select();

  if (error) throw error;
  return data[0];
}

export async function executeSequence(sequenceId: string, contactId: string) {
  const { data: sequence, error: seqError } = await supabase
    .from('hermes_sequences')
    .select('*')
    .eq('id', sequenceId)
    .single();

  if (seqError) throw seqError;
  if (!sequence.isActive) return;

  // Execute each step in sequence
  for (const step of sequence.steps) {
    if (step.delay) {
      await new Promise(resolve => setTimeout(resolve, step.delay * 60 * 1000));
    }

    switch (step.action) {
      case 'send_email':
        // Call Brevo API
        const emailRes = await fetch('/api/outreach/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contactId,
            templateId: step.config.templateId,
            subject: step.config.subject,
          }),
        });
        if (!emailRes.ok) throw new Error('Failed to send email');
        break;

      case 'add_tag':
        // Update contact with tag
        await supabase
          .from('contacts')
          .update({ notes: step.config.tag })
          .eq('id', contactId);
        break;

      case 'update_score':
        // Increment engagement score
        await supabase.rpc('increment_contact_score', {
          contact_id: contactId,
          increment: step.config.scoreIncrease,
        });
        break;

      case 'create_task':
        // Log task for manual follow-up
        console.log(`Task: ${step.config.title} for contact ${contactId}`);
        break;
    }
  }
}

export async function triggerSequencesByCondition(brandId: string, contactId: string) {
  const { data: contact } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .single();

  if (!contact) return;

  // Find matching sequences
  const { data: sequences } = await supabase
    .from('hermes_sequences')
    .select('*')
    .eq('brand_id', brandId)
    .eq('is_active', true);

  for (const seq of sequences || []) {
    if (seq.trigger === 'high_score' && contact.score >= 80) {
      await executeSequence(seq.id, contactId);
    }
    if (seq.trigger === 'no_engagement' && contact.status === 'new') {
      // Trigger after 7 days
      const createdAt = new Date(contact.created_at);
      const daysSince = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince >= 7) {
        await executeSequence(seq.id, contactId);
      }
    }
  }
}
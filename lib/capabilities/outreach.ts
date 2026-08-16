import { z } from 'zod';
import { supabase, getVentures, getVenture } from '@/lib/db';
import { sendOutreachEmail } from '@/lib/outreach';
import { listSequences, enrollContacts } from '@/lib/sequences';
import { generateOutreach } from '@/lib/ai/generation';
import { obj, S, type Capability } from './types';

// Module-local ownership helper — replaces TOOLS.getLead pattern
async function getLeadOwned(accountId: string, id: string) {
  const { data } = await supabase.from('contacts').select('*').eq('id', id).eq('account_id', accountId).single();
  if (!data) throw new Error('Lead not found');
  return data;
}

export const OUTREACH_CAPABILITIES: Capability[] = [
  {
    name: 'draftOutreach',
    domain: 'outreach',
    title: 'Draft outreach email',
    description: 'Draft a personalized outreach email to a lead, grounded in the venture pitch and sender persona. Returns a subject + body for review. Does NOT send.',
    gate: 'read',
    inputSchema: obj({ contactId: S.string, goal: S.string, tone: S.string }, ['contactId', 'goal']),
    zod: z.object({ contactId: z.string(), goal: z.string(), tone: z.string().optional() }),
    run: async (accountId, { contactId, goal, tone }) => {
      const contact: any = await getLeadOwned(accountId, contactId);
      const v: any = contact.brand_id ? await getVenture(contact.brand_id) : (await getVentures(accountId))[0];
      return generateOutreach({
        contact,
        venture: {
          name: v?.name || 'our company', pitch: v?.pitch, senderName: v?.sender_name,
          senderRole: v?.sender_role, signature: v?.signature, defaultCta: v?.default_cta,
          skills: Array.isArray(v?.skills) ? v.skills : null,
        },
        goal, tone,
      });
    },
  },
  {
    name: 'sendEmail',
    domain: 'outreach',
    title: 'Send email to lead (SENDS to a real person)',
    description: 'Send an email to a lead now. Provide the lead id, subject, and body (html). This sends a real message — draft with draftOutreach first if unsure.',
    gate: 'external_send',
    inputSchema: obj({ contactId: S.string, subject: S.string, html: S.string }, ['contactId', 'subject']),
    zod: z.object({ contactId: z.string(), subject: z.string(), html: z.string().optional() }),
    run: (accountId, { contactId, subject, html }) => sendOutreachEmail({ contactId, subject, html, accountId }),
  },
  {
    name: 'listSequences',
    domain: 'outreach',
    title: 'List sequences',
    description: 'List the outreach follow-up sequences for a venture (resolve a venture id with listVentures first).',
    gate: 'read',
    inputSchema: obj({ brandId: S.string }, ['brandId']),
    zod: z.object({ brandId: z.string() }),
    run: (_accountId, { brandId }) => listSequences(brandId),
  },
  {
    name: 'enrollInSequence',
    domain: 'outreach',
    title: 'Enroll leads in sequence (SENDS to real people)',
    description: 'Enroll one or more leads into an outreach sequence, which will send them scheduled follow-up emails. Provide the sequence id and lead ids.',
    gate: 'external_send',
    inputSchema: obj({ sequenceId: S.string, contactIds: { type: 'array', items: { type: 'string' } } }, ['sequenceId', 'contactIds']),
    zod: z.object({ sequenceId: z.string(), contactIds: z.array(z.string()).min(1) }),
    run: (accountId, { sequenceId, contactIds }) => enrollContacts(sequenceId, accountId, contactIds),
  },
];

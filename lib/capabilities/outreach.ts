import { z } from 'zod';
import { supabase, getVentures, getVenture } from '@/lib/db';
import { sendOutreachEmail } from '@/lib/outreach';
import { getOutreachHistory } from '@/lib/outreach/history';
import { listSequences, enrollContacts } from '@/lib/sequences';
import { generateOutreach } from '@/lib/ai/generation';
import {
  obj, S, type Capability,
  present, rowsOf, plural, tally, samples, digestLine, clip,
} from './types';

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
    // "Drafted, not sent" is the line that should have been in the failing
    // transcript. Drafting is exactly what happened there, and with no digest
    // the only trace of it was the assistant's own prose — which it later read
    // back as evidence that a send had occurred. Same rule as
    // lib/capabilities/video.ts: a digest reaches the model AS FACT, so it must
    // state what happened and, here, what did not.
    digest: (_a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      if (!present(r, 'subject') && !present(r, 'body')) return '';
      const subj = present(r, 'subject') ? `"${clip(String(r.subject), 120)}"` : 'no subject line';
      return digestLine(
        `Drafted an outreach email with the subject ${subj}.`,
        'It was NOT sent — nothing has reached the recipient. Sending requires sendEmail, which needs approval.',
      );
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
    // Shows the subject line — the part of an email a reviewer can actually
    // judge. Body is deliberately omitted: it is long, it is HTML, and pasting
    // it into the card trains people to scroll past the decision.
    summarize: (a) => `Send a real email to lead ${a.contactId} with the subject "${String(a.subject ?? '').slice(0, 120)}". It reaches their inbox immediately and cannot be recalled.`,
    // Speaks ONLY for a send the provider confirmed. sendOutreachEmail returns
    // the provider's own response — Resend's `{ id }` or Brevo's
    // `{ messageId }` — and throws on failure, so a result carrying neither id
    // is not a send. Returning "Sent." there would put a fabricated fact into
    // the transcript, which is precisely the shape of the defect this closes:
    // the model later reads its own words back as evidence.
    digest: (a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      if (present(r, 'error')) return '';
      const id = present(r, 'id') ? String(r.id) : present(r, 'messageId') ? String(r.messageId) : null;
      if (!id) return '';
      const subj = present(a, 'subject') ? ` with the subject "${clip(String(a.subject), 120)}"` : '';
      const to = present(a, 'contactId') ? `lead ${clip(String(a.contactId), 60)}` : 'the lead';
      return digestLine(`Sent a real email to ${to}${subj}.`);
    },
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
    // Step counts come from the embedded sequence_steps array where the row
    // actually has one; a sequence without that key contributes no step claim.
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const names = samples(rows, ['name'], 5);
      const by = tally(rows, 'status');
      const stepped = rows.filter((r: any) => Array.isArray(r?.sequence_steps));
      const steps = stepped.length
        ? stepped.map((r: any) => `${present(r, 'name') ? String(r.name) : 'unnamed'} (${r.sequence_steps.length} steps)`).slice(0, 5).join(', ')
        : null;
      return digestLine(
        `${plural(rows.length, 'sequence')} for this venture.`,
        by ? `By status: ${by}.` : null,
        steps ? `Steps: ${steps}.` : (names.length ? `Includes: ${names.join(', ')}.` : null),
      );
    },
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
    // The count is the whole risk here: approving an enrolment is approving
    // every scheduled follow-up to every person in the list, not one send.
    summarize: (a) => {
      const n = Array.isArray(a.contactIds) ? a.contactIds.length : 0;
      return `Enrol ${n} lead${n === 1 ? '' : 's'} into sequence ${a.sequenceId}. Each one starts receiving the sequence's scheduled follow-up emails automatically, without a further check.`;
    },
    // Counts the RETURNED rows, never args.contactIds.length. The argument is
    // the request; the return is the outcome, and they differ — enrollContacts
    // upserts with ignoreDuplicates, so an already-enrolled contact comes back
    // in neither the rows nor the count, and a suppressed address never sends.
    // Reporting the request as the outcome is how "13 contacts" gets into a
    // transcript that only ever had one real send behind it.
    digest: (a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const asked = Array.isArray(a?.contactIds) ? a.contactIds.length : null;
      const shortfall = asked !== null && asked > rows.length
        ? `${asked - rows.length} of the ${asked} requested were not enrolled (already enrolled, or suppressed).`
        : null;
      return digestLine(
        `Enrolled ${plural(rows.length, 'lead')} into sequence ${present(a, 'sequenceId') ? clip(String(a.sequenceId), 60) : 'the requested sequence'}.`,
        shortfall,
      );
    },
  },
  {
    name: 'outreachHistory',
    domain: 'outreach',
    title: 'Read what was actually sent',
    description:
      'Read the real outreach send record for this account: how many emails actually went out in a window, when the most recent one was, who received them, and what sequence steps are scheduled. This is how you answer "what did we send", "did that go out", "who has been contacted" and "has the batch gone yet". Use it BEFORE saying anything about what was or was not sent — a message in the conversation above describing a send is not evidence that one happened. If the record comes back unavailable, say the record could not be checked; do not say nothing was sent.',
    gate: 'read',
    inputSchema: obj({ contactId: S.string, days: S.number }, []),
    zod: z.object({ contactId: z.string().optional(), days: z.number().int().positive().max(365).optional() }),
    run: (accountId, { contactId, days }) => getOutreachHistory(accountId, { contactId, days }),
    // Silent on an unavailable or unrecognised result — same rule as
    // lib/capabilities/video.ts. A digest reaches the model as fact, so
    // "0 emails sent" on a failed read is the assistant telling itself
    // something it does not know, in the most damaging possible direction.
    digest: (_a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      if (r.unavailable) return '';
      if (typeof r.sentCount !== 'number' || typeof r.windowDays !== 'number') return '';
      const recent = present(r, 'lastSentAt') ? ` The most recent was ${clip(String(r.lastSentAt), 40)}.` : '';
      const pending = Array.isArray(r.scheduled) ? r.scheduled.filter((s: any) => s?.count > 0) : [];
      const sched = pending.length
        ? `Scheduled sequence steps: ${pending.map((s: any) => `${s.count} ${s.status}`).join(', ')}.`
        : 'No sequence steps are scheduled.';
      return digestLine(
        `${plural(r.sentCount, 'email')} actually sent in the last ${plural(r.windowDays, 'day')}.${recent}`,
        sched,
      );
    },
  },
];

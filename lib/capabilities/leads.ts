import { z } from 'zod';
import { supabase, getContacts, updateContact, createContact } from '@/lib/db';
import { searchPeople, matchPerson } from '@/lib/integrations/apollo';
import { listTags, addTagToContact } from '@/lib/tags';
import {
  obj, S, type Capability,
  present, rowsOf, firstField, plural, tally, samples, clip, digestLine,
} from './types';

/** A field the API takes as one string, but that the model often supplies as a
 *  list. Accepts either and normalises to a comma-separated string. */
const listOrString = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : v));

// Module-local ownership helper — replaces TOOLS.getLead pattern
async function getLeadOwned(accountId: string, id: string) {
  const { data } = await supabase.from('contacts').select('*').eq('id', id).eq('account_id', accountId).single();
  if (!data) throw new Error('Lead not found');
  return data;
}

export const LEAD_CAPABILITIES: Capability[] = [
  {
    name: 'listLeads',
    domain: 'leads',
    title: 'List leads',
    description: 'List leads/contacts across the account.',
    gate: 'read',
    inputSchema: obj({ limit: S.number, offset: S.number }),
    zod: z.object({ limit: z.number().optional(), offset: z.number().optional() }),
    run: (accountId, { limit = 50, offset = 0 }) => getContacts(accountId, 'all', limit, offset),
    // Truthful: counts only the rows returned, and states a status breakdown
    // only over rows that actually carry a status. Says nothing about totals
    // beyond this page — the result does not contain one.
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const by = tally(rows, 'status');
      const names = samples(rows, ['name', 'company', 'email']);
      return digestLine(
        `${plural(rows.length, 'lead')} returned.`,
        by ? `By status: ${by}.` : null,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'getLead',
    domain: 'leads',
    title: 'Get lead',
    description: 'Get a single lead/contact by id.',
    gate: 'read',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: async (accountId, { id }) => getLeadOwned(accountId, id),
    // Only fields the row actually carries are mentioned. A missing score is
    // absent from the sentence rather than reported as 0.
    digest: (_args, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const who = firstField(result, ['name', 'email']);
      const bits = [
        present(result, 'title') ? `title ${clip(String(result.title), 40)}` : null,
        present(result, 'company') ? `at ${clip(String(result.company), 40)}` : null,
        present(result, 'status') ? `status ${result.status}` : null,
        present(result, 'score') ? `score ${result.score}` : null,
        present(result, 'segment') ? `segment ${result.segment}` : null,
      ].filter(Boolean);
      if (!who && !bits.length) return '';
      return digestLine(`Lead${who ? ` ${who}` : ''}${bits.length ? `: ${bits.join(', ')}` : ''}.`);
    },
  },
  {
    name: 'sourceLeads',
    domain: 'leads',
    title: 'Source leads (uses credits)',
    description: 'Find new leads/people matching a target profile (titles, seniority, location, industry, keywords, company size). Returns candidates with names/companies; emails stay masked until you reveal one. Uses sourcing credits.',
    gate: 'spend',
    inputSchema: obj({ titles: { type: 'array', items: { type: 'string' } }, seniority: { type: 'array', items: { type: 'string' } }, location: S.string, industry: S.string, keywords: S.string, companySize: S.string, limit: S.number }),
    // titles/seniority are lists and the other four are single strings — a
    // distinction the model does not reliably observe. A real proposal came in
    // as location:["United States","United Arab Emirates"],
    // industry:["marketing","media","venture capital"], keywords:[...],
    // companySize:[...]: the intent was perfectly clear and the call would have
    // been rejected as invalid arguments after the user had already approved
    // spending credits on it. Accept either shape and join, rather than failing
    // a request we understood.
    zod: z.object({
      titles: z.array(z.string()).optional(),
      seniority: z.array(z.string()).optional(),
      location: listOrString,
      industry: listOrString,
      keywords: listOrString,
      companySize: listOrString,
      limit: z.number().max(25).optional(),
    }),
    run: (accountId, a) => searchPeople(accountId, { titles: a.titles, seniority: a.seniority, location: a.location, industry: a.industry, keywords: a.keywords, company_size: a.companySize, limit: a.limit ?? 10 }),
    // States the credit cost and the actual filters, so the reviewer can catch a
    // search that is too broad BEFORE it is paid for.
    summarize: (a) => {
      const filters = [
        a.titles?.length ? `titles ${a.titles.join('/')}` : null,
        a.seniority?.length ? `seniority ${a.seniority.join('/')}` : null,
        a.industry ? `industry ${a.industry}` : null,
        a.location ? `in ${a.location}` : null,
        a.companySize ? `company size ${a.companySize}` : null,
        a.keywords ? `matching "${a.keywords}"` : null,
      ].filter(Boolean);
      return `Spend sourcing credits to find up to ${a.limit ?? 10} new leads${filters.length ? `: ${filters.join(', ')}` : ' (no filters set — this searches broadly)'}.`;
    },
  },
  {
    name: 'enrichLead',
    domain: 'leads',
    title: 'Reveal lead details (uses credits)',
    description: "Reveal a lead's verified email and full profile. Pass a lead id (an existing contact) OR identity hints (email/linkedinUrl/name+company). Uses sourcing credits. Does NOT save a contact record — if this person isn't already a lead id you passed in, call createLead with the result before draftOutreach/sendEmail.",
    gate: 'spend',
    inputSchema: obj({ contactId: S.string, email: S.string, linkedinUrl: S.string, name: S.string, company: S.string }),
    zod: z.object({ contactId: z.string().optional(), email: z.string().optional(), linkedinUrl: z.string().optional(), name: z.string().optional(), company: z.string().optional() }),
    run: async (accountId, a) => {
      let keys: any = { email: a.email, linkedin_url: a.linkedinUrl, name: a.name, company: a.company };
      if (a.contactId) {
        const c: any = await getLeadOwned(accountId, a.contactId);
        keys = { id: c.apollo_person_id || null, email: c.email || a.email, name: c.name || a.name, company: c.company || a.company, linkedin_url: c.linkedin_url || a.linkedinUrl };
      }
      return matchPerson(accountId, keys);
    },
    // Names WHO is being revealed. "contactId: abc123" tells a reviewer nothing;
    // a name or an email lets them notice it is the wrong person.
    summarize: (a) => {
      const who = a.name || a.email || a.linkedinUrl || (a.contactId ? `lead ${a.contactId}` : 'this person');
      return `Spend a sourcing credit to reveal the verified email and full profile for ${who}${a.company ? ` at ${a.company}` : ''}.`;
    },
  },
  {
    name: 'createLead',
    domain: 'leads',
    title: 'Create lead',
    description: "Add a new lead/contact to the CRM. Use this after enrichLead reveals a new person's details — enrichLead only looks the profile up, it does not save a contact record, and draftOutreach/sendEmail require one. If a contact with this email already exists, returns the existing record instead of creating a duplicate.",
    gate: 'internal_write',
    inputSchema: obj({ name: S.string, email: S.string, company: S.string, title: S.string, linkedinUrl: S.string, brandId: S.string, source: S.string }, ['name', 'email']),
    zod: z.object({ name: z.string(), email: z.string(), company: z.string().optional(), title: z.string().optional(), linkedinUrl: z.string().optional(), brandId: z.string().optional(), source: z.string().optional() }),
    run: async (accountId, a) => {
      const { data: existing } = await supabase.from('contacts').select('*').eq('account_id', accountId).ilike('email', a.email).maybeSingle();
      if (existing) return existing;
      return createContact({
        account_id: accountId,
        name: a.name,
        email: a.email,
        company: a.company || null,
        title: a.title || null,
        linkedin_url: a.linkedinUrl || null,
        brand_id: a.brandId || null,
        source: a.source || 'manual',
        status: 'new',
      });
    },
    digest: (_args, result) => {
      if (!result || typeof result !== 'object') return '';
      const who = firstField(result, ['name', 'email']);
      return digestLine(`Lead${who ? ` ${who}` : ''} created.`);
    },
  },
  {
    name: 'updateLeadStatus',
    domain: 'leads',
    title: 'Update lead status',
    description: "Set a lead's status. One of: new, outreaching, replied, qualified, dead.",
    gate: 'internal_write',
    inputSchema: obj({ id: S.string, status: S.string }, ['id', 'status']),
    zod: z.object({ id: z.string(), status: z.enum(['new', 'outreaching', 'replied', 'qualified', 'dead']) }),
    run: (accountId, { id, status }) => updateContact(id, accountId, { status }),
  },
  {
    name: 'listTags',
    domain: 'leads',
    title: 'List tags',
    description: 'List the lead tags in the account.',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listTags(accountId),
  },
  {
    name: 'tagLead',
    domain: 'leads',
    title: 'Tag lead',
    description: 'Add a tag to a lead. Pass an existing tagId, or a name (a new tag is created if needed).',
    gate: 'internal_write',
    inputSchema: obj({ contactId: S.string, tagId: S.string, name: S.string, color: S.string }, ['contactId']),
    zod: z.object({ contactId: z.string(), tagId: z.string().optional(), name: z.string().optional(), color: z.string().optional() }),
    run: (accountId, { contactId, tagId, name, color }) => addTagToContact(accountId, contactId, { tagId, name, color }),
  },
];

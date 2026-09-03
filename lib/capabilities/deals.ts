// Packet 2.2 — pipeline/deals domain. Thin wrappers over lib/crm.ts's
// account-scoped deal + activity functions; no business logic reimplemented.
// createDeal/moveDeal/addNote already shipped in capabilities/crm.ts (2.1) —
// this file fills the read/update/delete/activity surface the plan flagged
// as missing.
import { z } from 'zod';
import { assertBrandOwned } from '@/lib/db';
import {
  getDeals, getDeal, updateDeal, deleteDeal, getActivities, createActivity,
  countDeals, countDealsGrouped,
} from '@/lib/crm';
import {
  obj, S, type Capability,
  present, rowsOf, plural, tally, samples, digestLine, projectRows,
} from './types';

/** Fields listDeals returns per row — only those actually present on a given
 *  deal row survive; that's the point of projectRows. See the same note on
 *  listLeads in lib/capabilities/leads.ts. */
const DEAL_LIST_FIELDS = [
  'id', 'title', 'name', 'value', 'amount', 'stage', 'stage_id', 'status',
  'company', 'contact_id', 'brand_id', 'created_at',
];

export const DEAL_CAPABILITIES: Capability[] = [
  {
    name: 'listDeals',
    domain: 'deals',
    title: 'List deals',
    description: 'List deals in the pipeline for the account, optionally filtered to one venture.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string, limit: S.number, offset: S.number }),
    zod: z.object({ brandId: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() }),
    run: async (accountId, { brandId, limit = 50, offset = 0 }) => {
      const clamped = Math.min(Math.max(Math.floor(limit), 1), 200);
      const rows = await getDeals(accountId, brandId, clamped, offset);
      return projectRows(rows, DEAL_LIST_FIELDS);
    },
    // Truthful over the returned page only: status/stage breakdowns count only
    // rows that carry the field, and never infer a total beyond this page.
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const byStatus = tally(rows, 'status');
      const names = samples(rows, ['name']);
      return digestLine(
        `${plural(rows.length, 'deal')} returned.`,
        byStatus ? `By status: ${byStatus}.` : null,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'countDeals',
    domain: 'deals',
    title: 'Count deals',
    description: "Count deals in the pipeline WITHOUT fetching any rows — use this instead of listDeals whenever the question is 'how many', not 'which ones'. Optionally scope to one venture with brandId, filter by stage (the pipeline stage's name), and/or break the total down with groupBy (brand or stage). The result is a total plus, if groupBy is set, a small list of per-group counts — never the underlying rows.",
    gate: 'read',
    inputSchema: obj({ brandId: S.string, stage: S.string, groupBy: S.string }),
    zod: z.object({
      brandId: z.string().optional(),
      stage: z.string().optional(),
      groupBy: z.enum(['brand', 'stage']).optional(),
    }),
    run: async (accountId, { brandId, stage, groupBy }) => {
      if (brandId) {
        const owned = await assertBrandOwned(brandId, accountId);
        if (!owned) throw new Error('Brand not found');
      }
      const filters = { brandId, stage };
      const total = await countDeals(accountId, filters);
      if (!groupBy) return { total };
      // Capped, not silently truncated into something misleading — see the
      // matching note on countLeads in lib/capabilities/leads.ts.
      const groups = (await countDealsGrouped(accountId, groupBy, filters)).slice(0, 25);
      return { total, groupBy, groups };
    },
    // Truthful: `total` and `groups` are exactly what the aggregate query
    // computed — never a count of rows the model happened to see elsewhere.
    digest: (_args, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      if (!present(result, 'total')) return '';
      const groups = Array.isArray((result as any).groups) ? (result as any).groups : null;
      const byGroup = groups && groups.length
        ? groups.slice(0, 8).map((g: any) => `${g.value}: ${g.count}`).join(', ')
        : null;
      return digestLine(
        `${plural(Number((result as any).total), 'deal')} total.`,
        byGroup ? `By ${(result as any).groupBy}: ${byGroup}.` : null,
      );
    },
  },
  {
    name: 'getDeal',
    domain: 'deals',
    title: 'Get deal',
    description: 'Get a single deal by id.',
    gate: 'read',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => getDeal(id, accountId),
  },
  {
    name: 'updateDeal',
    domain: 'deals',
    title: 'Update deal',
    description: 'Update a deal\'s fields (e.g. name or amount). Use moveDeal instead to change its pipeline stage.',
    gate: 'internal_write',
    inputSchema: obj({ id: S.string, name: S.string, amount: S.number }, ['id']),
    zod: z.object({ id: z.string(), name: z.string().optional(), amount: z.number().optional() }),
    run: (accountId, { id, ...updates }) => updateDeal(id, accountId, updates),
  },
  {
    name: 'deleteDeal',
    domain: 'deals',
    title: 'Delete deal',
    description: 'Delete a deal from the pipeline. This is a soft delete and cannot be undone from chat.',
    gate: 'destructive',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => deleteDeal(id, accountId),
    summarize: (a) => `Delete deal ${a.id} from the pipeline.`,
  },
  {
    name: 'listActivities',
    domain: 'deals',
    title: 'List activities',
    description: 'List logged activities (calls, tasks, etc), optionally filtered to a lead, deal, or company.',
    gate: 'read',
    inputSchema: obj({ contactId: S.string, dealId: S.string, companyId: S.string, limit: S.number }),
    zod: z.object({ contactId: z.string().optional(), dealId: z.string().optional(), companyId: z.string().optional(), limit: z.number().optional() }),
    run: (accountId, { contactId, dealId, companyId, limit = 100 }) =>
      getActivities(accountId, { contactId, dealId, companyId }, limit),
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const byType = tally(rows, 'type');
      const subjects = samples(rows, ['subject']);
      return digestLine(
        `${plural(rows.length, 'activity', 'activities')} returned.`,
        byType ? `By type: ${byType}.` : null,
        subjects.length ? `Subjects include: ${subjects.join(' | ')}.` : null,
      );
    },
  },
  {
    name: 'logActivity',
    domain: 'deals',
    title: 'Log activity',
    description: 'Log an activity (e.g. a call or task) against a lead, deal, and/or company. Provide a type and optional subject/body.',
    gate: 'internal_write',
    inputSchema: obj({ type: S.string, subject: S.string, body: S.string, contactId: S.string, dealId: S.string, companyId: S.string, brandId: S.string }, ['type']),
    zod: z.object({
      type: z.string(),
      subject: z.string().optional(),
      body: z.string().optional(),
      contactId: z.string().optional(),
      dealId: z.string().optional(),
      companyId: z.string().optional(),
      brandId: z.string().optional(),
    }),
    run: (accountId, a) => createActivity({
      account_id: accountId, brand_id: a.brandId, type: a.type, subject: a.subject, body: a.body,
      contact_id: a.contactId, deal_id: a.dealId, company_id: a.companyId,
    }),
  },
];

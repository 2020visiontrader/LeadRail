// Packet 2.2 — pipeline/deals domain. Thin wrappers over lib/crm.ts's
// account-scoped deal + activity functions; no business logic reimplemented.
// createDeal/moveDeal/addNote already shipped in capabilities/crm.ts (2.1) —
// this file fills the read/update/delete/activity surface the plan flagged
// as missing.
import { z } from 'zod';
import { getDeals, getDeal, updateDeal, deleteDeal, getActivities, createActivity } from '@/lib/crm';
import {
  obj, S, type Capability,
  rowsOf, plural, tally, samples, digestLine,
} from './types';

export const DEAL_CAPABILITIES: Capability[] = [
  {
    name: 'listDeals',
    domain: 'deals',
    title: 'List deals',
    description: 'List deals in the pipeline for the account, optionally filtered to one venture.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string, limit: S.number, offset: S.number }),
    zod: z.object({ brandId: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() }),
    run: (accountId, { brandId, limit = 100, offset = 0 }) => getDeals(accountId, brandId, limit, offset),
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

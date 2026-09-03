// Packet 2.2 — companies domain. Thin wrappers over lib/crm.ts's
// account-scoped company functions; no business logic reimplemented.
import { z } from 'zod';
import { assertBrandOwned } from '@/lib/db';
import {
  getCompanies, getCompany, createCompany, linkContactCompany,
  countCompanies, countCompaniesGrouped,
} from '@/lib/crm';
import {
  obj, S, type Capability,
  present, rowsOf, plural, samples, digestLine, projectRows,
} from './types';

/** Fields listCompanies returns per row — see the same note on listLeads in
 *  lib/capabilities/leads.ts. */
const COMPANY_LIST_FIELDS = [
  'id', 'name', 'domain', 'industry', 'size', 'employee_count', 'brand_id', 'created_at',
];

export const COMPANY_CAPABILITIES: Capability[] = [
  {
    name: 'listCompanies',
    domain: 'companies',
    title: 'List companies',
    description: 'List companies in the account, optionally scoped to one venture with brandId.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string, limit: S.number, offset: S.number }),
    zod: z.object({ brandId: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() }),
    run: async (accountId, { brandId, limit = 25, offset = 0 }) => {
      const clamped = Math.min(Math.max(Math.floor(limit), 1), 100);
      // Ownership-checked, matching listLeads/listDeals — see the comment on
      // listDeals in lib/capabilities/deals.ts for why this throws instead of
      // relying solely on getCompanies's account_id AND brand_id scoping.
      if (brandId) {
        const owned = await assertBrandOwned(brandId, accountId);
        if (!owned) throw new Error('Brand not found');
      }
      const rows = await getCompanies(accountId, brandId, clamped, offset);
      return projectRows(rows, COMPANY_LIST_FIELDS);
    },
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const names = samples(rows, ['name', 'domain']);
      return digestLine(
        `${plural(rows.length, 'company', 'companies')} returned.`,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'countCompanies',
    domain: 'companies',
    title: 'Count companies',
    description: "Count companies in the account WITHOUT fetching any rows — use this instead of listCompanies whenever the question is 'how many', not 'which ones'. Optionally scope to one venture with brandId, and/or break the total down with groupBy (brand or industry). The result is a total plus, if groupBy is set, a small list of per-group counts — never the underlying rows.",
    gate: 'read',
    inputSchema: obj({ brandId: S.string, groupBy: S.string }),
    zod: z.object({
      brandId: z.string().optional(),
      groupBy: z.enum(['brand', 'industry']).optional(),
    }),
    run: async (accountId, { brandId, groupBy }) => {
      if (brandId) {
        const owned = await assertBrandOwned(brandId, accountId);
        if (!owned) throw new Error('Brand not found');
      }
      const filters = { brandId };
      const total = await countCompanies(accountId, filters);
      if (!groupBy) return { total };
      // Capped, not silently truncated into something misleading — see the
      // matching note on countLeads in lib/capabilities/leads.ts.
      const groups = (await countCompaniesGrouped(accountId, groupBy, filters)).slice(0, 25);
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
        `${plural(Number((result as any).total), 'company', 'companies')} total.`,
        byGroup ? `By ${(result as any).groupBy}: ${byGroup}.` : null,
      );
    },
  },
  {
    name: 'getCompany',
    domain: 'companies',
    title: 'Get company',
    description: 'Get a single company by id.',
    gate: 'read',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => getCompany(id, accountId),
  },
  {
    name: 'createCompany',
    domain: 'companies',
    title: 'Create company',
    description: 'Create a company record. Provide a name; optionally a venture id, domain, and industry.',
    gate: 'internal_write',
    inputSchema: obj({ name: S.string, brandId: S.string, domain: S.string, industry: S.string }, ['name']),
    zod: z.object({ name: z.string(), brandId: z.string().optional(), domain: z.string().optional(), industry: z.string().optional() }),
    run: (accountId, a) => createCompany({ account_id: accountId, brand_id: a.brandId, name: a.name, domain: a.domain, industry: a.industry }),
  },
  {
    name: 'linkContactToCompany',
    domain: 'companies',
    title: 'Link lead to company',
    description: 'Link a lead/contact to a company. Optionally set their role and whether they are the primary contact.',
    gate: 'internal_write',
    inputSchema: obj({ contactId: S.string, companyId: S.string, role: S.string, isPrimary: { type: 'boolean' } }, ['contactId', 'companyId']),
    zod: z.object({ contactId: z.string(), companyId: z.string(), role: z.string().optional(), isPrimary: z.boolean().optional() }),
    run: (accountId, a) => linkContactCompany({
      account_id: accountId, contact_id: a.contactId, company_id: a.companyId, role: a.role, is_primary: a.isPrimary,
    }),
  },
];

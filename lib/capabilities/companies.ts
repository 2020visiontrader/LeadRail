// Packet 2.2 — companies domain. Thin wrappers over lib/crm.ts's
// account-scoped company functions; no business logic reimplemented.
import { z } from 'zod';
import { getCompanies, getCompany, createCompany, linkContactCompany } from '@/lib/crm';
import {
  obj, S, type Capability,
  rowsOf, plural, samples, digestLine,
} from './types';

export const COMPANY_CAPABILITIES: Capability[] = [
  {
    name: 'listCompanies',
    domain: 'companies',
    title: 'List companies',
    description: 'List companies in the account, optionally filtered to one venture.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string, limit: S.number, offset: S.number }),
    zod: z.object({ brandId: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() }),
    run: (accountId, { brandId, limit = 50, offset = 0 }) => getCompanies(accountId, brandId, limit, offset),
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

// Packet 2.2 — search domain. Thin wrapper over lib/search.ts's
// account-scoped full-text search.
import { z } from 'zod';
import { searchEntities } from '@/lib/search';
import { obj, S, type Capability, plural, samples, digestLine } from './types';

export const SEARCH_CAPABILITIES: Capability[] = [
  {
    name: 'globalSearch',
    domain: 'search',
    title: 'Search',
    description: 'Full-text search across the account\'s contacts and companies for a query string.',
    gate: 'read',
    inputSchema: obj({ query: S.string, limit: S.number }, ['query']),
    zod: z.object({ query: z.string().min(1), limit: z.number().optional() }),
    run: (accountId, { query, limit = 20 }) => searchEntities(accountId, query, limit),
    digest: (_args, result) => {
      if (!result || typeof result !== 'object') return '';
      const contacts = Array.isArray(result.contacts) ? result.contacts : null;
      const companies = Array.isArray(result.companies) ? result.companies : null;
      const contactNames = contacts ? samples(contacts, ['name', 'email']) : [];
      const companyNames = companies ? samples(companies, ['name', 'domain']) : [];
      return digestLine(
        contacts ? `${plural(contacts.length, 'contact')} matched.` : null,
        companies ? `${plural(companies.length, 'company', 'companies')} matched.` : null,
        contactNames.length ? `Contacts include: ${contactNames.join(', ')}.` : null,
        companyNames.length ? `Companies include: ${companyNames.join(', ')}.` : null,
      );
    },
  },
];

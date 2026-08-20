// Packet 2.2 — search domain. Thin wrapper over lib/search.ts's
// account-scoped full-text search.
import { z } from 'zod';
import { searchEntities } from '@/lib/search';
import { webSearch as runWebSearch } from '@/lib/integrations/websearch';
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
  // Packet W1 — open-web search (Tavily primary, SerpAPI fallback). Appended,
  // never inserted above globalSearch: CATALOG_ORDER position is what matters
  // for prompt stability, not position in this array.
  {
    name: 'webSearch',
    domain: 'search',
    title: 'Search the web',
    description: 'Search the open internet for current information not in the CRM — news, company research, competitor info, general facts. Not for searching your own contacts/companies (use globalSearch) or connected Notion/Drive.',
    gate: 'read',
    inputSchema: obj({ query: S.string, limit: S.number }, ['query']),
    zod: z.object({ query: z.string().min(1), limit: z.number().optional() }),
    run: async (_accountId, { query, limit = 5 }) => {
      try {
        return await runWebSearch(query, limit);
      } catch (e: any) {
        return { provider: null, query, results: [], error: e?.message || 'Web search failed — no provider configured or reachable.' };
      }
    },
    digest: (args, result) => {
      if (!result || typeof result !== 'object') return '';
      if (result.error) return digestLine(`Web search failed: ${String(result.error)}`);
      // A MISSING results array is not an empty one. Defaulting to [] here made
      // the digest report "0 web results for X" whenever the provider returned
      // a shape we did not expect — and the compose pass treats digest lines as
      // fact, so the model would tell the user the web is empty on the subject
      // when what actually happened is that the search broke. Say nothing about
      // a count we never saw; globalSearch above already does exactly this.
      const hits = Array.isArray(result.results) ? result.results : null;
      const titles = hits ? samples(hits, ['title'], 5) : [];
      const q = args?.query ? ` for "${String(args.query)}"` : '';
      return digestLine(
        hits ? `${plural(hits.length, 'web result')}${q}.` : null,
        result.answer ? `Direct answer: ${String(result.answer)}` : null,
        titles.length ? `Titles: ${titles.join(' | ')}.` : null,
      );
    },
  },
];

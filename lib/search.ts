import { supabase } from '@/lib/db';

// ============================================================
// Full-text search (gap #13). Uses the generated tsvector columns + GIN
// indexes from migration 010. Always account-scoped; skips soft-deleted rows.
// ============================================================

export async function searchEntities(accountId: string, query: string, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return { contacts: [], companies: [] };

  const [contacts, companies] = await Promise.all([
    supabase
      .from('contacts')
      .select('id, name, email, company, title, status')
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .textSearch('search_tsv', q, { type: 'websearch', config: 'english' })
      .limit(limit),
    supabase
      .from('companies')
      .select('id, name, domain, industry')
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .textSearch('search_tsv', q, { type: 'websearch', config: 'english' })
      .limit(limit),
  ]);

  return {
    contacts: contacts.data ?? [],
    companies: companies.data ?? [],
  };
}

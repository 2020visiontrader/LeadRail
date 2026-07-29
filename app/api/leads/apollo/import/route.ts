import { NextRequest, NextResponse } from 'next/server';
import { candidateToContact } from '@/lib/integrations/apollo';
import { insertContacts, findContactByEmail, dbReady } from '@/lib/db';
import { scoreContact } from '@/lib/scoring';
import { upsertCompanyByName, writeAudit } from '@/lib/crm';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
import type { ApolloCandidate } from '@/lib/integrations/apollo';

export const dynamic = 'force-dynamic';

// POST /api/leads/apollo/import
// body: { accountId, brandId, candidates: ApolloCandidate[] }
// Persists selected Apollo candidates as contacts (source='apollo'), skipping
// duplicates by email. Returns { imported, skipped }.
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  if (!dbReady()) return badRequest('database not connected');

  let body: any;
  try {
    body = await request.json();
  } catch {
    return badRequest('invalid JSON body');
  }
  const { accountId, brandId } = body || {};
  const candidates: ApolloCandidate[] = Array.isArray(body?.candidates) ? body.candidates : [];
  if (!accountId || !brandId) return badRequest('accountId and brandId are required');
  if (!candidates.length) return badRequest('candidates array is required');

  try {
    const rows: Record<string, any>[] = [];
    let skipped = 0;
    const companyCache = new Map<string, string | null>();
    for (const c of candidates) {
      const row = candidateToContact(c, accountId, brandId);
      const existing = await findContactByEmail(row.email);
      if (existing) { skipped++; continue; }
      row.score = scoreContact(row.segment, row.title || '');
      // Build the Account layer: upsert the contact's org into companies and link it.
      const orgName = (c.company || '').trim();
      if (orgName) {
        let companyId = companyCache.get(orgName.toLowerCase());
        if (companyId === undefined) {
          const org = c.raw?.organization || {};
          companyId = await upsertCompanyByName(accountId, brandId, orgName, {
            industry: org.industry || undefined,
            website: org.website_url || undefined,
          });
          companyCache.set(orgName.toLowerCase(), companyId);
        }
        if (companyId) row.company_id = companyId;
      }
      rows.push(row);
    }
    const inserted = await insertContacts(rows);
    await writeAudit({ account_id: accountId, brand_id: brandId, action: 'import', entity_type: 'contact', detail: { imported: inserted.length, skipped, source: 'apollo' } });
    return NextResponse.json({ imported: inserted.length, skipped, contacts: inserted }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

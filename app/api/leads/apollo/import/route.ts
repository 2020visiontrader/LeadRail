import { NextRequest, NextResponse } from 'next/server';
import { candidateToContact } from '@/lib/integrations/apollo';
import { insertContacts, findContactByEmail, dbReady } from '@/lib/db';
import { scoreContact } from '@/lib/scoring';
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
    for (const c of candidates) {
      const row = candidateToContact(c, accountId, brandId);
      const existing = await findContactByEmail(row.email);
      if (existing) { skipped++; continue; }
      row.score = scoreContact(row.segment, row.title || '');
      rows.push(row);
    }
    const inserted = await insertContacts(rows);
    return NextResponse.json({ imported: inserted.length, skipped, contacts: inserted }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

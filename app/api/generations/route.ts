import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse } from '@/lib/http';
import {
  listGenerations, resolveGenerationUrl, accountStorageBytes, GENERATION_QUOTA_BYTES,
  type ReviewState, type GenerationKind,
} from '@/lib/generations/store';
export const dynamic = 'force-dynamic';

const REVIEW_STATES: ReviewState[] = ['PENDING', 'APPROVED', 'REJECTED'];
const KINDS: GenerationKind[] = ['image', 'video'];

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const { searchParams } = new URL(request.url);
    const brandId = searchParams.get('brandId') || undefined;
    const reviewStateParam = searchParams.get('reviewState') || undefined;
    const kindParam = searchParams.get('kind') || undefined;
    const limitParam = searchParams.get('limit');
    const reviewState = REVIEW_STATES.includes(reviewStateParam as ReviewState) ? (reviewStateParam as ReviewState) : undefined;
    const kind = KINDS.includes(kindParam as GenerationKind) ? (kindParam as GenerationKind) : undefined;
    const limit = limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10) || 50)) : undefined;

    const [rows, usedBytes] = await Promise.all([
      listGenerations(session.accountId, { brandId, reviewState, kind, limit }),
      accountStorageBytes(session.accountId),
    ]);
    // Every row gets a fresh, display-ready URL minted here — never persisted
    // (see resolveGenerationUrl's comment in lib/generations/store.ts).
    const generations = await Promise.all(rows.map(async (r) => ({ ...r, url: await resolveGenerationUrl(r) })));

    return NextResponse.json({
      generations,
      quota: { usedBytes, limitBytes: GENERATION_QUOTA_BYTES },
    });
  } catch (error) { return errorResponse(error); }
}

export const GET = withApi(GET__impl as any, { route: '/api/generations', method: 'GET' });

import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getGeneration } from '@/lib/generations/store';
import { GENERATIONS_CAPABILITIES } from '@/lib/capabilities/generations';
export const dynamic = 'force-dynamic';

// Reuses the exact same logic chat's promoteGenerationToContent capability
// runs (lib/capabilities/generations.ts) — one place owns "approved
// generation -> content item", not a second copy here.
const promoteCapability = GENERATIONS_CAPABILITIES.find((c) => c.name === 'promoteGenerationToContent')!;

async function POST__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    // Scope check up front — a generation belonging to another account must
    // read back as "not found", never be promotable via this route.
    const existing = await getGeneration(session.accountId, params.id);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const b = await request.json().catch(() => ({}));
    const result = await promoteCapability.run(session.accountId, {
      generationId: params.id,
      contentItemId: b?.contentItemId,
      title: b?.title,
      brandId: b?.brandId,
      platforms: b?.platforms,
      hook: b?.hook,
      body: b?.body,
      cta: b?.cta,
      status: b?.status,
    });
    return NextResponse.json(result);
  } catch (error) {
    // The capability throws plain, user-safe messages for expected
    // business-rule failures (not APPROVED yet, no resolvable URL) — surface
    // those as 400s rather than masking them behind a generic 500.
    if (error instanceof Error && error.message) return badRequest(error.message);
    return errorResponse(error);
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/generations/[id]/promote', method: 'POST' });

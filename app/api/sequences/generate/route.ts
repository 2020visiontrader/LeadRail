import { NextRequest, NextResponse } from 'next/server';
import { generateSequenceDraft } from '@/lib/ai/generation';
import { getTemplates, dbReady, assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const brandId = body?.brandId ? String(body.brandId) : '';
    const ventureName = body?.ventureName ? String(body.ventureName) : '';
    const description = body?.description ? String(body.description).trim() : '';
    if (!brandId || !ventureName || !description) {
      return badRequest('brandId, ventureName, and description are required');
    }
    if (!(await assertBrandOwned(brandId, session.accountId))) return badRequest('unknown brandId');

    let templateCategories: string[] = [];
    if (dbReady()) {
      const templates = await getTemplates(session.accountId, brandId);
      templateCategories = Array.from(
        new Set((templates || []).map((t: any) => t.category).filter(Boolean))
      );
    }

    const draft = await generateSequenceDraft({
      venture: { name: ventureName, pitch: body?.venturePitch ? String(body.venturePitch) : undefined },
      description,
      templateCategories,
    });
    return NextResponse.json(draft);
  } catch (error) {
    return errorResponse(error);
  }
}

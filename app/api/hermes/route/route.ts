import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { hermesRoute } from '@/lib/ai/hermes';

export const dynamic = 'force-dynamic';

// POST /api/hermes/route  body: { request: string, ventureName?, leadGoal?, sectors? }
// Returns Hermes' plan: the intent, chosen skills, and the Go model it picked.
// Admin/account-scoped. Never throws — falls back to keyword routing.
export async function POST(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const text = String(body?.request || body?.text || '').trim();
  if (!text) return badRequest('request is required');
  try {
    const plan = await hermesRoute(text, {
      ventureName: body?.ventureName,
      leadGoal: body?.leadGoal,
      sectors: Array.isArray(body?.sectors) ? body.sectors.map(String) : undefined,
    });
    return NextResponse.json({ plan });
  } catch (e) {
    return errorResponse(e);
  }
}

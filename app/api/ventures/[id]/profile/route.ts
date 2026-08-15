import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getVenture, updateVenture, assertBrandOwned, dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { profileVentureFromDeck } from '@/lib/ai/generation';
import { textConfigured } from '@/lib/ai/router';

export const dynamic = 'force-dynamic';

// POST /api/ventures/:id/profile
// Auto-profiles a venture from its stored basics (name + description + lead goal
// + sectors) WITHOUT a deck — the profiler infers the summary, value prop, and
// ICP. This is what makes profiling part of the regular onboarding: every new
// venture gets a grounded profile so the AI prompt boxes have context, even when
// the user never uploads a pitch deck. Deck upload (the /deck route) remains the
// richer path. Optional body { description, leadGoal, sectors } patches the
// basics first, so the wizard can create + profile in one round-trip.
async function POST__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not configured');
  if (!(await assertBrandOwned(params.id, session.accountId))) return badRequest('unknown venture');
  if (!textConfigured()) return NextResponse.json({ error: 'not_configured', provider: 'ai' }, { status: 409 });

  // Optional: patch the basics before profiling (create + profile in one call).
  let body: any = {};
  try { body = await request.json(); } catch { /* no body is fine */ }
  const basics: Record<string, any> = {};
  if (body?.description !== undefined) basics.description = String(body.description).slice(0, 4000);
  if (body?.leadGoal !== undefined) basics.lead_goal = String(body.leadGoal);
  if (Array.isArray(body?.sectors)) basics.sectors = body.sectors.map(String);
  if (Object.keys(basics).length) await updateVenture(params.id, session.accountId, basics);

  const venture = await getVenture(params.id);
  try {
    const profile = await profileVentureFromDeck({
      ventureName: venture?.name || params.id,
      description: venture?.description || undefined,
      leadGoal: venture?.lead_goal || undefined,
      sectors: Array.isArray(venture?.sectors) ? venture.sectors : [],
      deckText: '', // no deck — infer from basics
    });
    // Persist the derived profile. deck_summary doubles as the venture summary;
    // pitch is filled from value_prop only when the user hasn't set one.
    const patch: Record<string, any> = { deck_summary: profile.summary, icp_profile: profile.icp };
    if (!venture?.pitch && profile.value_prop) patch.pitch = profile.value_prop;
    const saved = await updateVenture(params.id, session.accountId, patch);
    return NextResponse.json({ profile, venture: saved });
  } catch (e: any) {
    return errorResponse(e, 502, `profiling failed: ${e?.message || 'AI error'}`);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/ventures/[id]/profile", method: "POST" });

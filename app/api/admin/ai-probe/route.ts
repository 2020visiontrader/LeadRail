import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse } from '@/lib/http';
import { zoAskConfigured, zoAskText } from '@/lib/ai/zoask';
import * as opencode from '@/lib/ai/opencode';
import { nimConfigured, nimText } from '@/lib/ai/nim';
import { huggingfaceConfigured, hfText } from '@/lib/ai/huggingface';
import { openrouterConfigured, openrouterText } from '@/lib/ai/openrouter';
import { tierOrder, breakerState } from '@/lib/ai/router';
import { healthSnapshot, HEALTH_REORDER } from '@/lib/ai/health';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Every tier is probed in parallel, but a slow one still needs room to answer.
export const maxDuration = 90;

// POST /api/admin/ai-probe — smoke-test every AI tier and report which ones
// actually answer. Owner only.
//
// WHY THIS EXISTS
// Until now the only way to learn the state of the model ladder was to send a
// real prompt and read the failure logs afterwards — which conflates "this tier
// is broken" with "this tier was never reached because an earlier one answered"
// and with "this tier has no key so the router skipped it silently". Three very
// different problems that looked identical from outside.
//
// This calls each tier DIRECTLY with a trivial prompt, in parallel, and reports
// per-tier: configured / ok / failed, the latency, and the error verbatim. It is
// the difference between guessing at the ladder and knowing it.
//
// Deliberately cheap: a 6-token answer per tier. Safe to run often.
const PROMPT = 'Reply with exactly one word: ok';

interface TierResult {
  tier: string;
  configured: boolean;
  ok: boolean;
  ms: number | null;
  answer?: string;
  error?: string;
}

async function probe(tier: string, configured: boolean, run: () => Promise<string>): Promise<TierResult> {
  if (!configured) {
    // A tier with no key is NOT a failure — it is simply absent, and saying so
    // explicitly is the whole point. An unconfigured tier previously looked the
    // same as a broken one in the logs: silence.
    return { tier, configured: false, ok: false, ms: null, error: 'no API key configured — tier is skipped by the router' };
  }
  const t0 = Date.now();
  try {
    const answer = await run();
    return { tier, configured: true, ok: true, ms: Date.now() - t0, answer: String(answer).trim().slice(0, 80) };
  } catch (e: any) {
    return { tier, configured: true, ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 300) };
  }
}

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (session.role !== 'owner' && session.role !== 'admin') {
    return NextResponse.json({ error: 'Owners only' }, { status: 403 });
  }

  try {
    const opts = { prompt: PROMPT, temperature: 0, maxOutputTokens: 16 };

    // In parallel: the ladder's ORDER is irrelevant here — we want the state of
    // every tier, not whichever one happens to answer first.
    const results = await Promise.all([
      probe('zoask', zoAskConfigured(), () => zoAskText({ prompt: PROMPT, maxOutputTokens: 16 })),
      probe('opencode', opencode.opencodeConfigured(), () => opencode.generateText(opts as any)),
      probe('nim', nimConfigured(), () => nimText(opts as any)),
      probe('huggingface', huggingfaceConfigured(), () => hfText(opts as any)),
      probe('openrouter', openrouterConfigured(), () => openrouterText(opts as any)),
    ]);

    const working = results.filter((r) => r.ok).map((r) => r.tier);
    const order = tierOrder();
    return NextResponse.json({
      ok: working.length > 0,
      working,
      // The first working tier in the LIVE ladder order — read from tierOrder()
      // so AI_TIER_ORDER is reflected. This was a hardcoded array, which meant
      // the probe kept reporting servingTier: "zoask" after the order was
      // changed to put nim first. A diagnostic that lies about the thing it
      // exists to measure is worse than no diagnostic.
      tierOrder: order,
      // Which tiers the router is currently skipping, and for how long.
      breakers: breakerState(),
      // Per-candidate health, including the rolling latency of SUCCESSFUL calls.
      // This is what `tierOrder` should be set from: the probe above measures a
      // single cold call, while these are the numbers from real traffic. It does
      // not reorder anything by itself unless AI_HEALTH_REORDER=1 — the order is
      // the operator's decision, and this is the evidence for making it.
      health: healthSnapshot().sort((a, b) => (a.ewmaMs ?? Infinity) - (b.ewmaMs ?? Infinity)),
      healthReorder: HEALTH_REORDER,
      servingTier: order.find((t) => working.includes(t)) ?? null,
      results,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/admin/ai-probe', method: 'POST' });

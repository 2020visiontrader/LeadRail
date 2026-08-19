import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse } from '@/lib/http';
import { nimConfigured, MODEL_CHAIN as NIM_CHAIN, probeNimModel } from '@/lib/ai/nim';
import { openrouterConfigured, MODEL_CHAIN as OR_CHAIN, probeOpenrouterModel } from '@/lib/ai/openrouter';
import { huggingfaceConfigured, MODEL_CHAIN as HF_CHAIN, probeHfModel } from '@/lib/ai/huggingface';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Every model in every chain, so this needs real headroom.
export const maxDuration = 300;

// POST /api/admin/model-probe — test EVERY model in EVERY chain. Owner only.
//
// /api/admin/ai-probe answers "does this tier answer", which is one model deep:
// the chain returns as soon as anything works, so a tier reporting "ok" tells
// you nothing about the ten models sitting behind the one that answered. A
// retired id or a permanently-404ing entry is invisible until it is the only one
// left — which is exactly how a dead meta/llama-3.1-8b-instruct took the whole
// assistant down earlier.
//
// This walks each chain entry individually and reports per model: ok, latency,
// and the verbatim error. That turns chain ORDER from a guess into a measurement
// — the fastest healthy model should lead, and dead entries should be dropped or
// demoted rather than silently costing a timeout each time the chain walks past.
//
// Models within a tier are probed SEQUENTIALLY on purpose: firing 11 concurrent
// requests at one provider is the fastest way to get rate-limited and measure
// the rate limiter instead of the models.
interface ModelResult {
  model: string;
  ok: boolean;
  ms: number;
  answer?: string;
  error?: string;
}

async function probeChain(
  tier: string,
  configured: boolean,
  chain: readonly string[],
  run: (model: string) => Promise<string>,
): Promise<{ tier: string; configured: boolean; models: ModelResult[] }> {
  if (!configured) return { tier, configured: false, models: [] };
  const models: ModelResult[] = [];
  for (const model of chain) {
    const t0 = Date.now();
    try {
      const answer = await run(model);
      models.push({ model, ok: true, ms: Date.now() - t0, answer: answer.slice(0, 40) });
    } catch (e: any) {
      models.push({ model, ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return { tier, configured: true, models };
}

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (session.role !== 'owner' && session.role !== 'admin') {
    return NextResponse.json({ error: 'Owners only' }, { status: 403 });
  }

  try {
    // Tiers in parallel (different providers, no shared rate limit), models
    // within a tier sequentially.
    const tiers = await Promise.all([
      probeChain('nim', nimConfigured(), NIM_CHAIN, probeNimModel),
      probeChain('openrouter', openrouterConfigured(), OR_CHAIN, probeOpenrouterModel),
      probeChain('huggingface', huggingfaceConfigured(), HF_CHAIN, probeHfModel),
    ]);

    const summary = tiers.map((t) => {
      const ok = t.models.filter((m) => m.ok);
      const fastest = [...ok].sort((a, b) => a.ms - b.ms)[0];
      return {
        tier: t.tier,
        configured: t.configured,
        working: ok.length,
        total: t.models.length,
        dead: t.models.filter((m) => !m.ok).map((m) => m.model),
        // If this is not the chain's first entry, the chain is ordered wrong and
        // is paying a failure (or a slower model) before reaching its best one.
        fastestWorking: fastest ? { model: fastest.model, ms: fastest.ms } : null,
        chainLeader: t.models[0]?.model ?? null,
      };
    });

    return NextResponse.json({ summary, tiers });
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/admin/model-probe', method: 'POST' });

// A budget query. The property that matters is what it does with an UNKNOWN
// price, because that is the case where being helpful and being wrong look the
// same.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));
vi.mock('@/lib/ai/openrouter', () => ({ MODEL_CHAIN: ['already/in-chain'] }));

function catalogue(models: any[]) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: models }) });
}

const M = (id: string, prompt: any, completion: any, ctx?: number) => ({
  id, pricing: { prompt, completion }, context_length: ctx,
});

describe('affordableModels', () => {
  beforeEach(() => { vi.resetModules(); fetchMock.mockReset(); });

  it('keeps only models inside BOTH ceilings', async () => {
    // Per-token strings, as OpenRouter quotes them: 0.0000001 = $0.10/M.
    catalogue([
      M('cheap/both', '0.0000001', '0.0000009'),      // $0.10 in, $0.90 out
      M('pricey/output', '0.0000001', '0.000002'),    // output over
      M('pricey/input', '0.000001', '0.0000009'),     // input over
    ]);
    const { affordableModels } = await import('@/lib/ai/validate-models');
    const { models } = await affordableModels({ maxInPerMTok: 0.10, maxOutPerMTok: 0.90 });
    expect(models.map((m) => m.id)).toEqual(['cheap/both']);
  });

  it('treats the ceilings as inclusive', async () => {
    catalogue([M('exactly/at-limit', '0.0000001', '0.0000009')]);
    const { affordableModels } = await import('@/lib/ai/validate-models');
    const { models } = await affordableModels({ maxInPerMTok: 0.10, maxOutPerMTok: 0.90 });
    expect(models).toHaveLength(1);
  });

  it('EXCLUDES a model whose price the catalogue does not state', async () => {
    // Not "assume free". An unpriced entry is the one most likely to surprise a
    // bill, and this exists to answer a budget question.
    catalogue([M('mystery/price', undefined, undefined), M('known/price', '0', '0')]);
    const { affordableModels } = await import('@/lib/ai/validate-models');
    const { models } = await affordableModels({ maxInPerMTok: 1, maxOutPerMTok: 1 });
    expect(models.map((m) => m.id)).toEqual(['known/price']);
  });

  it('sorts cheapest output first', async () => {
    catalogue([
      M('mid/out', '0', '0.0000005'),
      M('low/out', '0', '0.0000001'),
      M('high/out', '0', '0.0000009'),
    ]);
    const { affordableModels } = await import('@/lib/ai/validate-models');
    const { models } = await affordableModels({ maxInPerMTok: 1, maxOutPerMTok: 1 });
    expect(models.map((m) => m.id)).toEqual(['low/out', 'mid/out', 'high/out']);
  });

  it('can drop the free tier, which the asker already has', async () => {
    catalogue([M('free/one', '0', '0'), M('paid/one', '0', '0.0000001')]);
    const { affordableModels } = await import('@/lib/ai/validate-models');
    const { models } = await affordableModels({ maxInPerMTok: 1, maxOutPerMTok: 1, excludeFree: true });
    expect(models.map((m) => m.id)).toEqual(['paid/one']);
  });

  it('marks what is already in the chain, so the answer is actionable', async () => {
    catalogue([M('already/in-chain', '0', '0'), M('new/candidate', '0', '0')]);
    const { affordableModels } = await import('@/lib/ai/validate-models');
    const { models } = await affordableModels({ maxInPerMTok: 1, maxOutPerMTok: 1 });
    expect(models.find((m) => m.id === 'already/in-chain')?.inChain).toBe(true);
    expect(models.find((m) => m.id === 'new/candidate')?.inChain).toBe(false);
  });

  it('reports the catalogue as unreachable rather than returning an empty list', async () => {
    // "Nothing is affordable" and "I could not look" must not read the same.
    fetchMock.mockResolvedValue({ ok: false });
    const { affordableModels } = await import('@/lib/ai/validate-models');
    const r = await affordableModels({ maxInPerMTok: 1, maxOutPerMTok: 1 });
    expect(r.catalogueReachable).toBe(false);
    expect(r.models).toEqual([]);
  });
});

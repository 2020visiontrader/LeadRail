// The chain is data, and data with no test drifts. These pin MODEL_CHAIN to
// the approved paid roster (migrations/077_provider_catalogue_restructure.sql)
// so the free-first regression this file used to encode cannot happen again
// silently — a drift here must fail loudly, not decay back to guesswork.

import { describe, it, expect, vi, afterEach } from 'vitest';

// The four OpenRouter rows enabled after migration 077 — three inserted by
// that migration (Luna, Haiku, Sonnet) plus openai/gpt-oss-120b, which
// migration 073 already enabled and 077 left untouched. This is the roster
// tests assert against; it is deliberately NOT imported from openrouter.ts
// so the test can't trivially pass by echoing whatever the source file says.
const APPROVED_ROSTER = [
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5.6-luna',
  'anthropic/claude-sonnet-5',
  'openai/gpt-oss-120b',
];

describe('OpenRouter model chain', () => {
  const ORIGINAL_ENV = process.env.OPENROUTER_MODEL;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = ORIGINAL_ENV;
  });

  it('contains no ":free" slug — free models were the measured cause of the failures this chain exists to avoid', async () => {
    delete process.env.OPENROUTER_MODEL;
    vi.resetModules();
    const { MODEL_CHAIN } = await import('@/lib/ai/openrouter');
    const freeEntries = MODEL_CHAIN.filter((m) => m.includes(':free'));
    expect(freeEntries).toEqual([]);
  });

  it('every entry is in the approved paid roster from migration 077', async () => {
    delete process.env.OPENROUTER_MODEL;
    vi.resetModules();
    const { MODEL_CHAIN } = await import('@/lib/ai/openrouter');
    for (const model of MODEL_CHAIN) {
      expect(APPROVED_ROSTER).toContain(model);
    }
  });

  it('places every paid model before any fallback entry (i.e. the whole chain, since none are free)', async () => {
    delete process.env.OPENROUTER_MODEL;
    vi.resetModules();
    const { MODEL_CHAIN } = await import('@/lib/ai/openrouter');
    // "Paid precedes fallback" degenerates to "the chain has no fallback
    // entries at all" now that free models are removed rather than demoted —
    // assert that directly so this test still means something.
    const paidCount = MODEL_CHAIN.filter((m) => APPROVED_ROSTER.includes(m) && !m.includes(':free')).length;
    expect(paidCount).toBe(MODEL_CHAIN.length);
  });

  it('contains no duplicates', async () => {
    delete process.env.OPENROUTER_MODEL;
    vi.resetModules();
    const { MODEL_CHAIN } = await import('@/lib/ai/openrouter');
    expect(new Set(MODEL_CHAIN).size).toBe(MODEL_CHAIN.length);
  });

  it('is short enough that, at 30s per attempt (TIMEOUT_MS), the worst case is 120s — 4 models', async () => {
    delete process.env.OPENROUTER_MODEL;
    vi.resetModules();
    const { MODEL_CHAIN } = await import('@/lib/ai/openrouter');
    expect(MODEL_CHAIN.length).toBe(4);
    expect(MODEL_CHAIN.length * 30).toBe(120);
  });

  it('OPENROUTER_MODEL env override still collapses the chain to exactly that one model', async () => {
    process.env.OPENROUTER_MODEL = 'some/override-model';
    vi.resetModules();
    const { MODEL_CHAIN } = await import('@/lib/ai/openrouter');
    expect(MODEL_CHAIN).toEqual(['some/override-model']);
  });
});

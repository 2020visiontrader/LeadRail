// Context budgets are derived from the answering model's window, not written
// down six times. These pin the properties that matter: budgets SCALE with
// the window UP TO A CEILING no real model exceeds, a smaller or unknown
// window degrades to the old hardcoded numbers rather than to something
// worse, and BUDGET is exactly budgetsFor(CONTEXT_WINDOW_TOKENS) — one
// implementation, not two that can drift.
//
// The motivating failures this file guards against:
//  - a 34,456-character dictated brief reaching the model as 12,000
//    characters (~35%) because the attachment cap was a constant chosen when
//    the primary tier was assumed to be a 200k model;
//  - the OPPOSITE failure, fixed 2026-09-03: CONTEXT_WINDOW_TOKENS defaults
//    to 1,000,000, and a bare fraction of that (no ceiling) produced a
//    400,000-char observation budget and a 1,600,000-char compose block that
//    NO real model can hold — an OpenRouter call was paid for and rejected
//    with "maximum context length is 131072" as a direct result.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { budgetsFor, windowForModelId, BUDGET, CHARS_PER_TOKEN, CONTEXT_WINDOW_TOKENS } from '@/lib/ai/context-budget';

describe('budgets scale with the window, below their ceiling', () => {
  it('scales attachments proportionally while both windows sit under the ceiling', () => {
    // Ceiling is 400,000 chars, reached at a 200,000-token window (200_000 *
    // 4 * 0.5 = 400,000). 100k and 200k both land at or under it, so this is
    // the scaling zone, not the clamp.
    const small = budgetsFor(100_000);
    const large = budgetsFor(200_000);
    expect(large.attachmentChars).toBe(400_000);
    expect(small.attachmentChars).toBe(200_000);
    expect(large.attachmentChars / small.attachmentChars).toBeCloseTo(2, 1);
  });

  it('scales extraction and memoryBody the same way, under their own ceilings', () => {
    const small = budgetsFor(30_000);
    const large = budgetsFor(60_000);
    expect(large.extractionChars).toBeGreaterThan(small.extractionChars);
    expect(large.memoryBodyChars).toBeGreaterThanOrEqual(small.memoryBodyChars);
  });

  it('lets a 1M model read a 34k-character dictated brief whole', () => {
    // The exact case that prompted this file. 12,000 was ~35% of it; the
    // ceiling fix (400,000) still comfortably clears it.
    expect(budgetsFor(1_000_000).attachmentChars).toBeGreaterThan(34_456);
  });

  it('keeps the soft handoff below the hard one', () => {
    const b = budgetsFor(1_000_000);
    expect(b.softTokens).toBeLessThan(b.hardTokens);
  });

  it('never budgets the whole window to one consumer', () => {
    // A turn also carries the system block, the tool catalog, the grounding
    // sections and the model's own answer. Handing 100% to one part produces
    // a call that cannot complete, not a thorough one.
    const b = budgetsFor(1_000_000);
    expect(b.attachmentChars).toBeLessThan(1_000_000 * CHARS_PER_TOKEN);
    expect(b.hardTokens).toBeLessThan(1_000_000);
  });
});

describe('ceilings bind — no real model exceeds them', () => {
  it('at a 1M window, every budget equals its ceiling', () => {
    // 1M is the platform default (CONTEXT_WINDOW_TOKENS), and the whole
    // point of this fix: a fraction of it must not exceed what any chain
    // model (128K-200K, see lib/ai/openrouter.ts / lib/ai/opencode.ts) can
    // actually hold.
    const b = budgetsFor(1_000_000);
    expect(b.observationChars).toBe(24_000);
    expect(b.composeBlockChars).toBe(160_000);
    expect(b.attachmentChars).toBe(400_000);
    expect(b.softTokens).toBe(120_000);
    expect(b.hardTokens).toBe(160_000);
    expect(b.extractionChars).toBe(120_000);
    expect(b.memoryBodyChars).toBe(8_000);
  });

  it('at a 10M (absurd) window, nothing exceeds its ceiling', () => {
    const b = budgetsFor(10_000_000);
    expect(b.observationChars).toBeLessThanOrEqual(24_000);
    expect(b.composeBlockChars).toBeLessThanOrEqual(160_000);
    expect(b.attachmentChars).toBeLessThanOrEqual(400_000);
    expect(b.softTokens).toBeLessThanOrEqual(120_000);
    expect(b.hardTokens).toBeLessThanOrEqual(160_000);
    expect(b.extractionChars).toBeLessThanOrEqual(120_000);
    expect(b.memoryBodyChars).toBeLessThanOrEqual(8_000);
    // And it should actually be AT the ceiling, not silently floored.
    expect(b.observationChars).toBe(24_000);
    expect(b.attachmentChars).toBe(400_000);
  });

  it('at a 128K window, the fractions apply where they land between floor and ceiling', () => {
    const b = budgetsFor(128_000);
    // attachments: 128_000 * 4 * 0.5 = 256,000 — between floor (12,000) and
    // ceiling (400,000), so the fraction applies verbatim.
    expect(b.attachmentChars).toBe(256_000);
    // observation/composeBlock/soft/hard have floor === ceiling by design
    // (24_000 / 160_000 / 120_000 / 160_000) — always exactly that value,
    // never a fraction of the window.
    expect(b.observationChars).toBe(24_000);
    expect(b.composeBlockChars).toBe(160_000);
    expect(b.softTokens).toBe(120_000);
    expect(b.hardTokens).toBe(160_000);
    // extraction: 128_000 * 4 * 0.2 = 102,400 — between its floor (12,000)
    // and ceiling (120,000).
    expect(b.extractionChars).toBe(102_400);
  });

  it('at a tiny (8K) window, nothing drops below its floor', () => {
    const b = budgetsFor(8_000);
    // 8,000 * 4 * 0.5 = 16,000, already above the 12,000 floor — the floor
    // guarantee still holds (nothing computes BELOW it), it just isn't the
    // binding constraint at this particular window.
    expect(b.attachmentChars).toBe(16_000);
    expect(b.attachmentChars).toBeGreaterThanOrEqual(12_000);
    expect(b.observationChars).toBe(24_000);
    expect(b.composeBlockChars).toBe(160_000);
    expect(b.softTokens).toBe(120_000);
    expect(b.hardTokens).toBe(160_000);
    expect(b.extractionChars).toBe(12_000);
    expect(b.memoryBodyChars).toBe(4_000);
  });
});

describe('one implementation, not two', () => {
  it('BUDGET is exactly budgetsFor(CONTEXT_WINDOW_TOKENS)', () => {
    expect(BUDGET).toEqual(budgetsFor(CONTEXT_WINDOW_TOKENS));
  });
});

describe('degrades, never below the old behaviour', () => {
  it('floors at the previous hardcoded values for a tiny window', () => {
    const b = budgetsFor(1_000);
    expect(b.attachmentChars).toBe(12_000);   // the old constant
    expect(b.observationChars).toBe(24_000);
    expect(b.softTokens).toBe(120_000);
    expect(b.hardTokens).toBe(160_000);
  });

  it('the default budget is at least the old behaviour', () => {
    expect(BUDGET.attachmentChars).toBeGreaterThanOrEqual(12_000);
    expect(BUDGET.observationChars).toBeGreaterThanOrEqual(24_000);
  });
});

describe('a model added later works without a code change', () => {
  it.each([
    ['claude-opus-5', 1_000_000],
    ['claude-sonnet-5', 1_000_000],
    ['claude-haiku-4-5', 200_000],
    ['deepseek-v4-pro', 128_000],
    ['meta-llama/Llama-3.3-70B-Instruct', 128_000],
    ['Qwen/Qwen3-235B-A22B-Instruct-2507', 262_144],
  ])('recognises %s', (id, expected) => {
    expect(windowForModelId(id)).toBe(expected);
  });

  it('returns null for an unknown id rather than guessing low', () => {
    // Guessing low would silently truncate a capable model. Null falls through
    // to the configured default, and a real value belongs on the ai_models row.
    expect(windowForModelId('some-model-nobody-has-seen')).toBeNull();
    expect(windowForModelId('')).toBeNull();
    expect(windowForModelId(null)).toBeNull();
  });
});

describe('resolution reads live data and never throws', () => {
  beforeEach(() => { vi.resetModules(); });

  it('takes the LARGEST window among an account\'s models', async () => {
    vi.doMock('@/lib/db', () => ({
      supabase: {
        from(t: string) {
          const q: any = {
            select: () => q,
            eq: () => Promise.resolve({ data: [{ id: 'p1' }], error: null }),
            in: () => Promise.resolve({
              data: [
                { model_id: 'deepseek-v4-pro', context_window: 128_000, enabled: true },
                { model_id: 'claude-opus-5', context_window: 1_000_000, enabled: true },
              ],
              error: null,
            }),
          };
          return q;
        },
      },
      dbReady: () => true,
    }));
    const { resolveContextWindowTokens } = await import('@/lib/ai/context-budget');
    // Budgeting for the biggest degrades (eligibility filters, and
    // filterEligible never empties the roster); budgeting for the smallest
    // would permanently waste the model that usually answers.
    expect(await resolveContextWindowTokens('acct-1')).toBe(1_000_000);
  });

  it('falls back to the default when the database is unreachable', async () => {
    vi.doMock('@/lib/db', () => ({
      supabase: { from() { throw new Error('down'); } },
      dbReady: () => false,
    }));
    const mod = await import('@/lib/ai/context-budget');
    await expect(mod.resolveContextWindowTokens('acct-1')).resolves.toBe(mod.CONTEXT_WINDOW_TOKENS);
  });

  it('falls back with no account id, without querying', async () => {
    const mod = await import('@/lib/ai/context-budget');
    expect(await mod.resolveContextWindowTokens()).toBe(mod.CONTEXT_WINDOW_TOKENS);
  });
});

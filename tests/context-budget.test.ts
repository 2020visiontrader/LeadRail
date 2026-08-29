// Context budgets are derived from the answering model's window, not written
// down six times. These pin the two properties that matter: budgets SCALE with
// the window, and a smaller or unknown window degrades to the old hardcoded
// numbers rather than to something worse.
//
// The motivating failure: a 34,456-character dictated brief reached the model
// as 12,000 characters — about a third — because the attachment cap was a
// constant chosen when the primary tier was assumed to be a 200k model.
// Dictation exists precisely so a long brief can be handed over in one go.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { budgetsFor, windowForModelId, BUDGET, CHARS_PER_TOKEN } from '@/lib/ai/context-budget';

describe('budgets scale with the window', () => {
  it('gives a 1M model roughly 5x the attachment room of a 200k model', () => {
    const small = budgetsFor(200_000);
    const large = budgetsFor(1_000_000);
    expect(large.attachmentChars / small.attachmentChars).toBeCloseTo(5, 0);
  });

  it('lets a 1M model read a 34k-character dictated brief whole', () => {
    // The exact case that prompted this. 12,000 was ~35% of it.
    expect(budgetsFor(1_000_000).attachmentChars).toBeGreaterThan(34_456);
  });

  it('scales every budget, not just attachments', () => {
    const small = budgetsFor(200_000);
    const large = budgetsFor(1_000_000);
    for (const k of ['observationChars', 'composeBlockChars', 'softTokens', 'hardTokens', 'extractionChars'] as const) {
      expect(large[k], k).toBeGreaterThan(small[k]);
    }
  });

  it('keeps the soft handoff below the hard one', () => {
    const b = budgetsFor(1_000_000);
    expect(b.softTokens).toBeLessThan(b.hardTokens);
  });

  it('derives delegateMaterialChars from the window, materially larger than the old flat 16,000', () => {
    // lib/agent/loop.ts's DELEGATE_MATERIAL_CHARS used to be a bare
    // `Number(process.env.DELEGATE_MATERIAL_CHARS) || 16_000` — the only
    // budget in the platform not derived from the window. At the default 1M
    // window this must resolve to far more than 16,000.
    expect(BUDGET.delegateMaterialChars).toBeGreaterThan(16_000);
    expect(BUDGET.delegateMaterialChars).toBe(1_000_000);
  });

  it('scales delegateMaterialChars down for a smaller model window, proportionally', () => {
    const small = budgetsFor(200_000);
    const large = budgetsFor(1_000_000);
    expect(small.delegateMaterialChars).toBeLessThan(large.delegateMaterialChars);
    // Exact: 200,000 tokens * 4 chars/token * 0.25 share = 200,000 chars.
    expect(small.delegateMaterialChars).toBe(200_000);
  });

  it('never budgets the whole window to one consumer', () => {
    // A turn also carries the system block, the tool catalog, the grounding
    // sections and the model's own answer. Handing 100% to one part produces a
    // call that cannot complete, not a thorough one.
    const b = budgetsFor(1_000_000);
    expect(b.attachmentChars).toBeLessThan(1_000_000 * CHARS_PER_TOKEN);
    expect(b.hardTokens).toBeLessThan(1_000_000);
  });
});

describe('degrades, never below the old behaviour', () => {
  it('floors at the previous hardcoded values for a tiny window', () => {
    const b = budgetsFor(1_000);
    expect(b.attachmentChars).toBe(12_000);   // the old constant
    expect(b.observationChars).toBe(24_000);
    expect(b.softTokens).toBe(120_000);
    expect(b.hardTokens).toBe(160_000);
    // delegateMaterialChars floors at the OLD flat DELEGATE_MATERIAL_CHARS
    // (lib/agent/loop.ts) — a misconfigured window must never make a
    // delegate's slice worse than the 16,000 it gets today.
    expect(b.delegateMaterialChars).toBe(16_000);
  });

  it('the default budget is at least the old behaviour', () => {
    expect(BUDGET.attachmentChars).toBeGreaterThanOrEqual(12_000);
    expect(BUDGET.observationChars).toBeGreaterThanOrEqual(24_000);
    expect(BUDGET.delegateMaterialChars).toBeGreaterThanOrEqual(16_000);
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

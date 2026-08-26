// Eligibility is the one stage of the selector that can REMOVE a model rather
// than reorder it, so the tests that matter are about what it refuses to remove:
// a model with no recorded capability, and the last model standing.

import { describe, it, expect } from 'vitest';
import { checkEligibility, filterEligible, estimateTokens } from '@/lib/ai/eligibility';

describe('estimateTokens', () => {
  it('estimates about four characters per token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('treats an empty string as nothing', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('checkEligibility', () => {
  it('rules out a model whose window is smaller than the prompt', () => {
    const v = checkEligibility({ context_window: 8_000 }, { promptTokens: 12_000 });
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toContain('context window is 8000');
  });

  it('accepts a model with room', () => {
    expect(checkEligibility({ context_window: 128_000 }, { promptTokens: 12_000 }).eligible).toBe(true);
  });

  it('requires headroom over the raw estimate', () => {
    // 10,000 estimated + 15% margin exceeds a 11,000 window. Being ruled out
    // beats overflowing by a few hundred tokens and reading as a model fault.
    expect(checkEligibility({ context_window: 11_000 }, { promptTokens: 10_000 }).eligible).toBe(false);
    expect(checkEligibility({ context_window: 12_000 }, { promptTokens: 10_000 }).eligible).toBe(true);
  });

  it('counts requested output against the window', () => {
    expect(checkEligibility({ context_window: 10_000 }, { promptTokens: 8_000 }).eligible).toBe(true);
    expect(
      checkEligibility({ context_window: 10_000 }, { promptTokens: 8_000, wantOutputTokens: 4_000 }).eligible,
    ).toBe(false);
  });

  it('rules out a model that cannot emit the requested output', () => {
    // A truncated answer looks like it worked, which is worse than a skip.
    const v = checkEligibility({ max_output_tokens: 1_024 }, { promptTokens: 10, wantOutputTokens: 4_096 });
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toContain('emits at most 1024');
  });

  it('never rules out on unknown capability', () => {
    // NULL means "cannot rule this in or out". Excluding on unknown would empty
    // the roster the first time someone adds a model without filling the field.
    expect(checkEligibility({}, { promptTokens: 500_000 }).eligible).toBe(true);
    expect(checkEligibility({ context_window: null }, { promptTokens: 500_000 }).eligible).toBe(true);
  });
});

describe('filterEligible', () => {
  const cap = (c: { context_window?: number | null }) => c;

  it('drops the models that cannot serve the call', () => {
    const models = [{ context_window: 4_000 }, { context_window: 200_000 }];
    expect(filterEligible(models, cap, { promptTokens: 20_000 })).toEqual([{ context_window: 200_000 }]);
  });

  it('returns everything when nothing qualifies', () => {
    // A filter that can empty the roster turns a sizing problem into a total
    // outage. The provider's own error is more useful than ours.
    const models = [{ context_window: 4_000 }, { context_window: 8_000 }];
    expect(filterEligible(models, cap, { promptTokens: 100_000 })).toEqual(models);
  });

  it('keeps candidates that carry no capability data at all', () => {
    // Ladder tiers own their internal model chains; there is nothing to check.
    const items = [{ tier: 'nim' }, { tier: 'openrouter' }];
    expect(filterEligible(items, () => undefined, { promptTokens: 999_999 })).toEqual(items);
  });

  it('reports why each exclusion happened', () => {
    const seen: string[] = [];
    filterEligible(
      [{ context_window: 4_000 }, { context_window: 200_000 }],
      cap,
      { promptTokens: 20_000 },
      (_c, reason) => seen.push(reason),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('context window is 4000');
  });
});

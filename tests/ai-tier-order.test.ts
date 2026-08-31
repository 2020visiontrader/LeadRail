// Production incident, 2026-08-28: NVIDIA NIM and HuggingFace were both
// failing (NIM timing out, HuggingFace returning 402 "depleted your monthly
// included credits"). Both were disabled account-side (ai_providers.enabled
// = false). This asserts they are ALSO gone from the ladder itself — if a
// caller ever re-set AI_TIER_ORDER or the env cleanup lapsed, an
// account-level re-enable of either provider must not silently put it back
// in the ladder.
//
// It also asserts OpenRouter's position AHEAD of both zoask and opencode —
// corrected 2026-08-31, reversing the PR #8 reorder that put opencode ahead
// of openrouter on a mistaken reading that OpenRouter was out of credit.
// Queried against PRODUCTION `ai_usage`, last 48h, successful calls only:
// zoask p50 35,621ms (77 calls, 15 timeouts), openrouter p50 8,233ms (66
// calls, 0 logged failures — it 402s on two chain models and succeeds on a
// third). opencode is last not because it is unproven but because it is
// measured SLOW and partly dead: its hardcoded tier's key 401'd 21/21 times
// (2026-08-27..28, none since), while its separate registry route (DeepSeek
// V4 Flash) does work — 152 successful calls — at ~46.1s average, the
// slowest of the three. See lib/ai/router.ts's DEFAULT_TIER_ORDER header
// comment for the full breakdown, and lib/ai/health.ts for HEALTH_REORDER —
// since this same date, the LIVE order is normally decided by measured
// latency, not this static seed; this constant only matters cold (nothing
// measured yet) or with AI_HEALTH_REORDER=0.

import { describe, it, expect, beforeEach } from 'vitest';

beforeEach(() => {
  delete process.env.AI_TIER_ORDER;
});

describe('DEFAULT_TIER_ORDER', () => {
  it('is exactly openrouter, zoask, opencode', async () => {
    const { DEFAULT_TIER_ORDER } = await import('@/lib/ai/router');
    expect(DEFAULT_TIER_ORDER).toEqual(['openrouter', 'zoask', 'opencode']);
  });

  it('never contains nim or huggingface', async () => {
    const { DEFAULT_TIER_ORDER } = await import('@/lib/ai/router');
    expect(DEFAULT_TIER_ORDER).not.toContain('nim');
    expect(DEFAULT_TIER_ORDER).not.toContain('huggingface');
  });
});

describe('tierOrder()', () => {
  it('matches DEFAULT_TIER_ORDER with no operator override', async () => {
    const { tierOrder, DEFAULT_TIER_ORDER } = await import('@/lib/ai/router');
    expect(tierOrder()).toEqual([...DEFAULT_TIER_ORDER]);
  });

  it('openrouter is tried before zoask and opencode (corrected 2026-08-31 — it is not out of credit, is the fastest proven tier, and opencode is measured slow/partly dead-keyed, not merely unproven)', async () => {
    const { tierOrder } = await import('@/lib/ai/router');
    const order = tierOrder();
    expect(order.indexOf('openrouter')).toBeLessThan(order.indexOf('zoask'));
    expect(order.indexOf('openrouter')).toBeLessThan(order.indexOf('opencode'));
  });

  it('ignores nim/huggingface even if an operator sets them via AI_TIER_ORDER', async () => {
    process.env.AI_TIER_ORDER = 'nim,huggingface,openrouter';
    const { tierOrder } = await import('@/lib/ai/router');
    const order = tierOrder();
    expect(order).not.toContain('nim');
    expect(order).not.toContain('huggingface');
    // openrouter was named, so it moves to the front of the remaining known
    // list; zoask/opencode — not named — are appended after it in their
    // default relative order.
    expect(order).toEqual(['openrouter', 'zoask', 'opencode']);
  });
});

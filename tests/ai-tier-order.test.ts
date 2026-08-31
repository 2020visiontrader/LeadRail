// Production incident, 2026-08-28: NVIDIA NIM and HuggingFace were both
// failing (NIM timing out, HuggingFace returning 402 "depleted your monthly
// included credits"). Both were disabled account-side (ai_providers.enabled
// = false). This asserts they are ALSO gone from the ladder itself — if a
// caller ever re-set AI_TIER_ORDER or the env cleanup lapsed, an
// account-level re-enable of either provider must not silently put it back
// in the ladder.
//
// It also asserts OpenCode Go's position AHEAD of OpenRouter — reordered
// 2026-08-31 at the user's explicit request, after OpenRouter was observed
// out of credit (402 on every chain model) that same day; OpenCode Go's own
// last-observed failure (401, 2026-08-28) is no more disqualifying than
// OpenRouter's, and orderByHealth + the health tracker's auth(401)->permanent
// and quota_exhausted(402)->hold-until-reset classification demote whichever
// tier is actually dead after ONE failure, not once per call — see
// lib/ai/router.ts's DEFAULT_TIER_ORDER header comment for the full reasoning.

import { describe, it, expect, beforeEach } from 'vitest';

beforeEach(() => {
  delete process.env.AI_TIER_ORDER;
});

describe('DEFAULT_TIER_ORDER', () => {
  it('is exactly zoask, opencode, openrouter', async () => {
    const { DEFAULT_TIER_ORDER } = await import('@/lib/ai/router');
    expect(DEFAULT_TIER_ORDER).toEqual(['zoask', 'opencode', 'openrouter']);
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

  it('opencode is tried before openrouter (user-requested reorder, 2026-08-31)', async () => {
    const { tierOrder } = await import('@/lib/ai/router');
    const order = tierOrder();
    expect(order.indexOf('opencode')).toBeLessThan(order.indexOf('openrouter'));
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

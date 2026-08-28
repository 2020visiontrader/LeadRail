// Production incident, 2026-08-28: NVIDIA NIM and HuggingFace were both
// failing (NIM timing out, HuggingFace returning 402 "depleted your monthly
// included credits"). Both were disabled account-side (ai_providers.enabled
// = false). This asserts they are ALSO gone from the ladder itself — if a
// caller ever re-set AI_TIER_ORDER or the env cleanup lapsed, an
// account-level re-enable of either provider must not silently put it back
// in the ladder.
//
// It also asserts OpenCode's demotion to last resort: its 401 is not a bad
// credential, the account has no credit, so a guaranteed-fail attempt must
// never sit ahead of a tier that can actually answer.

import { describe, it, expect, beforeEach } from 'vitest';

beforeEach(() => {
  delete process.env.AI_TIER_ORDER;
});

describe('DEFAULT_TIER_ORDER', () => {
  it('is exactly zoask, openrouter, opencode', async () => {
    const { DEFAULT_TIER_ORDER } = await import('@/lib/ai/router');
    expect(DEFAULT_TIER_ORDER).toEqual(['zoask', 'openrouter', 'opencode']);
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

  it('opencode sits last: zoask fails through to openrouter before opencode', async () => {
    const { tierOrder } = await import('@/lib/ai/router');
    const order = tierOrder();
    expect(order.indexOf('openrouter')).toBeLessThan(order.indexOf('opencode'));
  });

  it('ignores nim/huggingface even if an operator sets them via AI_TIER_ORDER', async () => {
    process.env.AI_TIER_ORDER = 'nim,huggingface,opencode';
    const { tierOrder } = await import('@/lib/ai/router');
    const order = tierOrder();
    expect(order).not.toContain('nim');
    expect(order).not.toContain('huggingface');
    // opencode was named, so it moves to the front of the remaining known
    // list; zoask/openrouter — not named — are appended after it in their
    // default relative order.
    expect(order).toEqual(['opencode', 'zoask', 'openrouter']);
  });
});

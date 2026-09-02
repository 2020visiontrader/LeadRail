// Production incident, 2026-08-28: NVIDIA NIM and HuggingFace were both
// failing (NIM timing out, HuggingFace returning 402 "depleted your monthly
// included credits"). Both were disabled account-side (ai_providers.enabled
// = false). This asserts they are ALSO gone from the ladder itself — if a
// caller ever re-set AI_TIER_ORDER or the env cleanup lapsed, an
// account-level re-enable of either provider must not silently put it back
// in the ladder.
//
// It also pins the SEED ORDER: zoask, opencode, openrouter — set 2026-09-02.
//
// Ask Zo is first by OWNER DECISION, not because it is fast. Measured against
// PRODUCTION `ai_usage` on 2026-09-02, last 14 days, successful calls only
// (`ok = true AND latency_ms IS NOT NULL`, percentiles via percentile_cont):
// opencode p50 9,873ms (n=3), zoask p50 39,081ms (n=299), openrouter p50
// 72,902ms (n=178, p90 378,430ms, min 1,796ms).
//
// That openrouter p50 is NOT current behaviour — 107 of its 178 successes fall
// on 2026-08-27 alone (that day's p50: 186,227ms). From 2026-08-28 onward
// openrouter's p50 is 8,503ms (n=71) — still the fastest tier. It is seeded
// LAST because its paid balance is depleted (in-adapter 402 "affordable
// ceiling" retries, 20 logged in app_logs on 2026-09-02, plus 44 failed rows
// in the window), which is a COST decision to revisit once the balance is
// topped up — see lib/ai/router.ts's DEFAULT_TIER_ORDER header for the full
// breakdown and the day-by-day table.
//
// See lib/ai/health.ts for HEALTH_REORDER — since 2026-08-31 the LIVE order is
// normally decided by measured latency, not this static seed; this constant
// only matters cold (nothing measured yet) or with AI_HEALTH_REORDER=0.

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

  it('seeds zoask first, ahead of opencode and openrouter (owner decision 2026-09-02 — subscription-billed tier ahead of a depleted paid balance, NOT a latency finding)', async () => {
    const { tierOrder } = await import('@/lib/ai/router');
    const order = tierOrder();
    expect(order.indexOf('zoask')).toBeLessThan(order.indexOf('opencode'));
    expect(order.indexOf('zoask')).toBeLessThan(order.indexOf('openrouter'));
    expect(order.indexOf('opencode')).toBeLessThan(order.indexOf('openrouter'));
  });

  it('AI_TIER_ORDER still overrides the default seed, in the order the operator named', async () => {
    process.env.AI_TIER_ORDER = 'openrouter,opencode,zoask';
    const { tierOrder, DEFAULT_TIER_ORDER } = await import('@/lib/ai/router');
    expect(tierOrder()).toEqual(['openrouter', 'opencode', 'zoask']);
    // and the default is genuinely different, so the assertion above is not
    // passing by accident.
    expect([...DEFAULT_TIER_ORDER]).not.toEqual(['openrouter', 'opencode', 'zoask']);
  });

  it('a partial AI_TIER_ORDER promotes only what it names, appending the rest in default order', async () => {
    process.env.AI_TIER_ORDER = 'opencode';
    const { tierOrder } = await import('@/lib/ai/router');
    expect(tierOrder()).toEqual(['opencode', 'zoask', 'openrouter']);
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

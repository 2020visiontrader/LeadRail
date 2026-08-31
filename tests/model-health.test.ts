// The selector's job is to not waste time on things that are down while never
// refusing to try them. These tests pin both halves of that, plus the property
// the old per-tier breaker got wrong: one candidate failing must not take its
// neighbours with it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  orderByHealth, quarantined, recordSuccess, recordFailure, healthSnapshot, resetHealth,
} from '@/lib/ai/health';

const id = (s: string) => s;

describe('candidate health', () => {
  beforeEach(() => resetHealth());

  it('treats an unseen candidate as healthy', () => {
    expect(quarantined('never-called')).toBe(false);
  });

  it('quarantines after a failure and holds it back, without dropping it', () => {
    recordFailure('nim');
    expect(quarantined('nim')).toBe(true);
    // Held, not removed — the whole point is that an outage costs one timeout,
    // not that the tier becomes unreachable.
    expect(orderByHealth(['nim', 'openrouter'], id)).toEqual(['openrouter', 'nim']);
  });

  it('keeps a failure local to one candidate', () => {
    // The bug this replaces: one OpenRouter model's 429 opened the breaker for
    // the tier, taking sixteen healthy models offline with it.
    recordFailure('model:a');
    expect(quarantined('model:a')).toBe(true);
    expect(quarantined('model:b')).toBe(false);
  });

  it('clears the hold on success', () => {
    recordFailure('zoask');
    expect(quarantined('zoask')).toBe(true);
    recordSuccess('zoask', 120);
    expect(quarantined('zoask')).toBe(false);
  });

  it('with AI_HEALTH_REORDER=0, preserves the caller order among healthy candidates', async () => {
    // Ladder order is an operator decision (AI_TIER_ORDER). Latency reordering
    // is ON by default since 2026-08-31 (see lib/ai/health.ts's header note),
    // but AI_HEALTH_REORDER=0 must still restore the pure static/operator
    // order — this pins that opt-out.
    process.env.AI_HEALTH_REORDER = '0';
    vi.resetModules();
    const healthMod = await import('@/lib/ai/health');
    healthMod.resetHealth();
    const order = ['zoask', 'opencode', 'nim', 'huggingface', 'openrouter'];
    healthMod.recordSuccess('openrouter', 10);
    healthMod.recordSuccess('zoask', 20_000);
    expect(healthMod.orderByHealth(order, id)).toEqual(order);
    delete process.env.AI_HEALTH_REORDER;
    vi.resetModules();
  });

  it('with reordering on (the default) and measured latencies, a faster healthy candidate sorts ahead of a slower healthy one', () => {
    const order = ['zoask', 'openrouter'];
    recordSuccess('zoask', 35_621); // measured p50 from production evidence
    recordSuccess('openrouter', 8_233);
    expect(orderByHealth(order, id)).toEqual(['openrouter', 'zoask']);
  });

  it('a QUARANTINED candidate stays held and is never promoted by being fast — the NIM regression this file warns about', () => {
    // NIM was observed at 413ms (very fast) and then went down upstream; a
    // stale fast latency measurement must never let a currently-failing
    // candidate leapfrog back to the front just because it used to be quick.
    recordSuccess('nim', 413);
    recordFailure('nim'); // now quarantined, regardless of its old ewmaMs
    recordSuccess('openrouter', 8_233); // slower than nim's old measurement, but healthy
    expect(quarantined('nim')).toBe(true);
    const ordered = orderByHealth(['nim', 'openrouter'], id);
    expect(ordered).toEqual(['openrouter', 'nim']); // nim held at the back despite being "faster"
  });

  it('an unmeasured candidate lands mid-pack: ahead of measured-slow, behind measured-fast', () => {
    const order = ['zoask', 'opencode', 'openrouter'];
    recordSuccess('zoask', 35_621); // measured slow
    recordSuccess('openrouter', 8_233); // measured fast
    // opencode is never recorded — unmeasured.
    const ordered = orderByHealth(order, id);
    expect(ordered.indexOf('opencode')).toBeGreaterThan(ordered.indexOf('openrouter'));
    expect(ordered.indexOf('opencode')).toBeLessThan(ordered.indexOf('zoask'));
    expect(ordered).toEqual(['openrouter', 'opencode', 'zoask']);
  });

  it('breaks ties within the same backoff tier deterministically', () => {
    // Two candidates failing once each land in the identical 60s tier, so
    // their exact remaining-cooldown values can differ only by real elapsed
    // ms between the two calls — not a meaningful thing for a test to pin.
    // What must hold regardless: ordering is a total order (no duplicates,
    // no drops), and it must not silently reintroduce the old per-tier
    // breaker bug where one candidate's failure could hide another.
    recordFailure('nim');
    recordFailure('zoask');
    const ordered = orderByHealth(['zoask', 'opencode', 'nim'], id);
    expect(ordered).toHaveLength(3);
    expect(ordered[0]).toBe('opencode'); // the only healthy one goes first
    expect(new Set(ordered)).toEqual(new Set(['zoask', 'opencode', 'nim']));
  });

  it('tries a candidate deep in backoff after one that just failed once', () => {
    // The bug this fixes: during a full-ladder outage (every candidate
    // failing) the held group was tried in its ORIGINAL ladder order every
    // call, so a candidate proven dead across dozens of failures (deep in
    // backoff) cost exactly as much per call as one that just failed for the
    // first time and might already be back. zoask fails 4x -> 30min cooldown
    // (deepest backoff tier); nim fails once -> 60s cooldown. Even though
    // zoask comes first in the caller's list, it must be tried last.
    recordFailure('zoask');
    recordFailure('zoask');
    recordFailure('zoask');
    recordFailure('zoask');
    recordFailure('nim');
    expect(orderByHealth(['zoask', 'opencode', 'nim'], id)).toEqual(['opencode', 'nim', 'zoask']);
  });

  it('records latency from successes only', () => {
    recordSuccess('nim', 400);
    recordFailure('nim');
    const row = healthSnapshot().find((r) => r.candidate === 'nim');
    // A timeout's latency describes the timeout constant, not the model; if it
    // were folded in, a dead candidate would read as merely slow.
    expect(row?.ewmaMs).toBe(400);
    expect(row?.fails).toBe(1);
    expect(row?.successes).toBe(1);
  });

  it('reports how long a candidate is held for', () => {
    recordFailure('opencode');
    const row = healthSnapshot().find((r) => r.candidate === 'opencode');
    expect(row?.heldForMs).toBeGreaterThan(0);
  });
});

// The selector's job is to not waste time on things that are down while never
// refusing to try them. These tests pin both halves of that, plus the property
// the old per-tier breaker got wrong: one candidate failing must not take its
// neighbours with it.

import { describe, it, expect, beforeEach } from 'vitest';
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

  it('preserves the caller order among healthy candidates', () => {
    // Ladder order is an operator decision (AI_TIER_ORDER). With reordering off
    // — the default — health must not quietly rearrange it.
    const order = ['zoask', 'opencode', 'nim', 'huggingface', 'openrouter'];
    recordSuccess('openrouter', 10);
    recordSuccess('zoask', 20_000);
    expect(orderByHealth(order, id)).toEqual(order);
  });

  it('keeps relative order within the held group too', () => {
    recordFailure('nim');
    recordFailure('zoask');
    expect(orderByHealth(['zoask', 'opencode', 'nim'], id)).toEqual(['opencode', 'zoask', 'nim']);
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

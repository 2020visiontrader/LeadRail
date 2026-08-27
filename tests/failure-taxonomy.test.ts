// The routing bug this fixes: 172 candidate failures / 84 quarantines in 24
// hours because recordFailure(id) knew only THAT something failed, never
// WHAT kind of failure it was — so a 30s timeout, a monthly-credit 402, and a
// permanently retired 404 slug all walked the identical 60s/5min/15min/30min
// ladder. These tests pin that each class now gets a schedule that matches
// its real recovery time, and that a call site which doesn't classify still
// gets the old (safe) behaviour.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordFailure, quarantined, healthSnapshot, resetHealth,
  classifyFailure, parseRetryAfterMs, msUntilNextReset, resetPeriodFor,
} from '@/lib/ai/health';
import { log } from '@/lib/logger';

describe('failure classification', () => {
  beforeEach(() => resetHealth());

  it('classifies a bare timeout/network error as transient', () => {
    const info = classifyFailure(new Error('OpenRouter timed out after 30000ms'));
    expect(info.kind).toBe('transient');
  });

  it('classifies a 500 as transient', () => {
    const info = classifyFailure({ status: 500, detail: 'internal server error' });
    expect(info.kind).toBe('transient');
  });

  it('classifies 429 as rate_limited and carries the Retry-After', () => {
    const info = classifyFailure({ status: 429, retryAfterMs: 12_000 });
    expect(info.kind).toBe('rate_limited');
    expect(info.retryAfterMs).toBe(12_000);
  });

  it('classifies 402 / "depleted" language as quota_exhausted', () => {
    expect(classifyFailure({ status: 402 }).kind).toBe('quota_exhausted');
    expect(
      classifyFailure({ status: 400, detail: 'You have depleted your monthly included credits' }).kind,
    ).toBe('quota_exhausted');
  });

  it('classifies 404 / dead-slug language as gone', () => {
    expect(classifyFailure({ status: 404 }).kind).toBe('gone');
    expect(classifyFailure({ status: 400, detail: 'unavailable for free — use this slug instead' }).kind).toBe('gone');
  });

  it('classifies 401 as auth', () => {
    expect(classifyFailure({ status: 401 }).kind).toBe('auth');
  });
});

describe('parseRetryAfterMs', () => {
  it('parses a delta-seconds header', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
  });

  it('parses an HTTP-date header', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThan(70_000);
  });

  it('returns undefined for absent/unparseable input', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('not-a-date-or-number')).toBeUndefined();
  });
});

describe('msUntilNextReset', () => {
  it('computes the exact instant of the next UTC month boundary, not a fixed duration', () => {
    // Fixed instant deep in August so the answer is pinned, not clock-raced.
    const from = new Date(Date.UTC(2026, 7, 27, 12, 0, 0)); // 2026-08-27T12:00:00Z
    const ms = msUntilNextReset('monthly', from);
    const resetAt = new Date(from.getTime() + ms);
    expect(resetAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('computes the next UTC midnight for daily', () => {
    const from = new Date(Date.UTC(2026, 7, 27, 23, 30, 0));
    const ms = msUntilNextReset('daily', from);
    expect(new Date(from.getTime() + ms).toISOString()).toBe('2026-08-28T00:00:00.000Z');
  });

  it('computes the next UTC Monday for weekly', () => {
    // 2026-08-27 is a Thursday.
    const from = new Date(Date.UTC(2026, 7, 27, 12, 0, 0));
    const ms = msUntilNextReset('weekly', from);
    const resetAt = new Date(from.getTime() + ms);
    expect(resetAt.getUTCDay()).toBe(1); // Monday
    expect(resetAt.getUTCHours()).toBe(0);
  });
});

describe('resetPeriodFor', () => {
  const ENV_KEY = 'AI_QUOTA_RESET_PERIOD_HUGGINGFACE';
  beforeEach(() => { delete process.env[ENV_KEY]; delete process.env.AI_QUOTA_RESET_PERIOD; });

  it('defaults to monthly with no override', () => {
    expect(resetPeriodFor('huggingface')).toBe('monthly');
  });

  it('honours an explicit resetPeriod over everything else', () => {
    expect(resetPeriodFor('huggingface', 'daily')).toBe('daily');
  });

  it('honours a per-provider env override', () => {
    process.env[ENV_KEY] = 'daily';
    expect(resetPeriodFor('huggingface')).toBe('daily');
    delete process.env[ENV_KEY];
  });
});

describe('recordFailure cooldown scheduling', () => {
  beforeEach(() => {
    resetHealth();
    vi.useRealTimers();
  });

  it('gives each failure class a DISTINCT hold, not one shared ladder', () => {
    recordFailure('transient-cand', { kind: 'transient' });
    recordFailure('rate-cand', { kind: 'rate_limited' }); // no Retry-After -> minutes default
    recordFailure('quota-cand', { kind: 'quota_exhausted' });
    recordFailure('gone-cand', { kind: 'gone' });
    recordFailure('auth-cand', { kind: 'auth' });

    const rows = new Map(healthSnapshot().map((r) => [r.candidate, r]));
    const transientMs = rows.get('transient-cand')!.heldForMs;
    const rateMs = rows.get('rate-cand')!.heldForMs;
    const quotaMs = rows.get('quota-cand')!.heldForMs;

    // Transient stays on the old short ladder (~60s).
    expect(transientMs).toBeGreaterThan(50_000);
    expect(transientMs).toBeLessThan(70_000);

    // Rate-limited defaults to MINUTES, not the 60s transient default.
    expect(rateMs).toBeGreaterThan(transientMs);

    // Quota-exhausted parks until next month — far longer than either.
    expect(quotaMs).toBeGreaterThan(rateMs);

    // Gone and auth are permanent: reported at the sentinel ceiling.
    expect(rows.get('gone-cand')!.heldForMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(rows.get('auth-cand')!.heldForMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(rows.get('gone-cand')!.permanent).toBe(true);
    expect(rows.get('auth-cand')!.permanent).toBe(true);
  });

  it('a 402 parks until the next monthly reset, not a 60s cooldown', () => {
    recordFailure('hf-model', { kind: 'quota_exhausted', status: 402, provider: 'huggingface' });
    const row = healthSnapshot().find((r) => r.candidate === 'hf-model')!;
    // Comfortably more than a day away — proves it is NOT on the 60s/5min/
    // 15min/30min transient ladder, which tops out at 30 minutes.
    expect(row.heldForMs).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it('a dead-slug 404 is never retried — quarantined stays true no matter how long you wait', () => {
    recordFailure('dead-model', { kind: 'gone', status: 404 });
    expect(quarantined('dead-model')).toBe(true);
    // Simulate "time passing" the only way available without faking the
    // clock: directly assert the class computed an unbounded hold, which is
    // exactly what makes quarantined() return true forever for this id.
    const row = healthSnapshot().find((r) => r.candidate === 'dead-model')!;
    expect(row.permanent).toBe(true);
    expect(row.kind).toBe('gone');
  });

  it('respects an explicit Retry-After over the rate-limited default', () => {
    recordFailure('short-rl', { kind: 'rate_limited', retryAfterMs: 2_000 });
    const row = healthSnapshot().find((r) => r.candidate === 'short-rl')!;
    expect(row.heldForMs).toBeLessThanOrEqual(2_000);
    expect(row.heldForMs).toBeGreaterThan(0);
  });

  it('logs the gone/auth class loudly exactly once, not on every repeated failure', () => {
    const spy = vi.spyOn(log, 'error');
    recordFailure('repeat-dead', { kind: 'gone', status: 404 });
    recordFailure('repeat-dead', { kind: 'gone', status: 404 });
    recordFailure('repeat-dead', { kind: 'gone', status: 404 });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('an unclassified call (no info arg) behaves exactly like the old breaker: transient', () => {
    recordFailure('legacy-caller');
    const row = healthSnapshot().find((r) => r.candidate === 'legacy-caller')!;
    expect(row.kind).toBe('transient');
    expect(row.heldForMs).toBeGreaterThan(50_000);
    expect(row.heldForMs).toBeLessThan(70_000);
    expect(row.permanent).toBe(false);
  });
});

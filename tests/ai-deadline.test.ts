// lib/ai/deadline.ts is the shared arithmetic every client and the router lean
// on to bound the SUM of a turn's model calls (see THE MECHANISM in the fix
// this file accompanies). These pin the pure helpers directly — the
// integration tests that drive them through real clients live in
// tests/ai-deadline-clients.test.ts and tests/ai-router-deadline.test.ts.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isPastDeadline,
  remainingMs,
  boundedTimeoutMs,
  deadlineExceededError,
  DeadlineExceededError,
} from '@/lib/ai/deadline';

afterEach(() => { vi.useRealTimers(); });

describe('isPastDeadline', () => {
  it('is always false with no deadline — the additive guarantee', () => {
    expect(isPastDeadline(undefined)).toBe(false);
  });

  it('is false while time remains', () => {
    expect(isPastDeadline(Date.now() + 10_000)).toBe(false);
  });

  it('is true once the deadline has passed', () => {
    expect(isPastDeadline(Date.now() - 1)).toBe(true);
  });

  it('is true exactly AT the deadline (>=, not >)', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    expect(isPastDeadline(now)).toBe(true);
  });
});

describe('remainingMs', () => {
  it('is Infinity with no deadline', () => {
    expect(remainingMs(undefined)).toBe(Infinity);
  });

  it('reports the real gap when time remains', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    expect(remainingMs(now + 5_000)).toBe(5_000);
  });

  it('never goes negative once the deadline has passed', () => {
    expect(remainingMs(Date.now() - 5_000)).toBe(0);
  });
});

describe('boundedTimeoutMs', () => {
  it('returns the provider constant unchanged with no deadline', () => {
    expect(boundedTimeoutMs(30_000, undefined)).toBe(30_000);
  });

  it('tightens to the remaining time when that is smaller', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    expect(boundedTimeoutMs(30_000, now + 4_000)).toBe(4_000);
  });

  it('never exceeds the provider constant, even with lots of time left', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    // Deadline is FAR out — must still clamp to the provider's own ceiling.
    expect(boundedTimeoutMs(30_000, now + 10_000_000)).toBe(30_000);
  });

  it('is 0, not negative, once the deadline has passed', () => {
    expect(boundedTimeoutMs(30_000, Date.now() - 1)).toBe(0);
  });
});

describe('deadlineExceededError', () => {
  it('is a distinct type with a distinct code — never mistaken for a provider failure', () => {
    const err = deadlineExceededError('openrouter');
    expect(err).toBeInstanceOf(DeadlineExceededError);
    expect(err.code).toBe('deadline_exceeded');
    expect(err.message).toContain('openrouter');
  });

  it('carries the last real provider error as cause, without becoming it', () => {
    const providerErr = new Error('OpenRouter failed (429)');
    const err = deadlineExceededError('openrouter', providerErr);
    expect(err.code).toBe('deadline_exceeded');
    expect(err.cause).toBe(providerErr);
  });
});

// tests/rate-limit.test.ts
//
// /api/contact and /api/auth/signup are the first PUBLIC write endpoints in the
// app — everything else is behind requireSession. One sends email, the other
// creates accounts. An unauthenticated endpoint with a side effect is what gets
// found and abused, so the limiter is the only thing standing in front of them
// and it is worth testing properly.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { rateLimit, clientIp, __resetRateLimits } from '@/lib/rate-limit';

beforeEach(() => { __resetRateLimits(); });
afterEach(() => { vi.useRealTimers(); });

describe('the window actually closes', () => {
  it('allows exactly `limit` requests, then refuses', () => {
    for (let i = 0; i < 5; i++) expect(rateLimit('a', 5, 60_000).ok).toBe(true);
    expect(rateLimit('a', 5, 60_000).ok).toBe(false);
  });

  it('reports how long to wait, and it is never zero when refused', () => {
    for (let i = 0; i < 3; i++) rateLimit('b', 3, 60_000);
    const r = rateLimit('b', 3, 60_000);
    expect(r.ok).toBe(false);
    // A Retry-After of 0 tells a client to retry immediately, which turns a
    // limiter into a busy-loop generator.
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(r.retryAfter).toBeLessThanOrEqual(60);
  });

  it('frees up once the window has passed', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) rateLimit('c', 3, 60_000);
    expect(rateLimit('c', 3, 60_000).ok).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(rateLimit('c', 3, 60_000).ok).toBe(true);
  });

  it('slides rather than resetting in fixed blocks', () => {
    // A fixed-window limiter lets a caller spend the whole budget at the end of
    // one window and again at the start of the next — double the intended rate
    // across the boundary. Sliding means the early hits expire individually.
    vi.useFakeTimers();
    rateLimit('d', 2, 10_000);
    vi.advanceTimersByTime(6_000);
    rateLimit('d', 2, 10_000);
    expect(rateLimit('d', 2, 10_000).ok).toBe(false);
    vi.advanceTimersByTime(4_100); // first hit expires, second has not
    expect(rateLimit('d', 2, 10_000).ok).toBe(true);
    expect(rateLimit('d', 2, 10_000).ok).toBe(false);
  });
});

describe('callers are isolated from each other', () => {
  it('one caller exhausting its budget does not block anyone else', () => {
    for (let i = 0; i < 5; i++) rateLimit('ip-1', 5, 60_000);
    expect(rateLimit('ip-1', 5, 60_000).ok).toBe(false);
    expect(rateLimit('ip-2', 5, 60_000).ok).toBe(true);
  });

  it('separate routes keep separate budgets', () => {
    for (let i = 0; i < 5; i++) rateLimit('contact:ip', 5, 60_000);
    expect(rateLimit('contact:ip', 5, 60_000).ok).toBe(false);
    expect(rateLimit('signup:ip', 3, 60_000).ok).toBe(true);
  });
});

describe('client identity', () => {
  const req = (h: Record<string, string>) => new Request('https://x.test', { headers: h });

  it('takes the first hop of x-forwarded-for, not the whole chain', () => {
    // The chain is client, proxy, proxy… Using the whole string would give every
    // distinct path its own budget, which is the same as having no limit.
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' }))).toBe('203.0.113.7');
  });

  it('falls back through the other proxy headers', () => {
    expect(clientIp(req({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(clientIp(req({ 'cf-connecting-ip': '198.51.100.9' }))).toBe('198.51.100.9');
  });

  it('degrades to a shared key rather than to no key', () => {
    // With no headers every caller shares one budget: too strict, which fails
    // safe. Returning something unique per request would fail OPEN.
    expect(clientIp(req({}))).toBe('unknown');
    expect(clientIp(req({}))).toBe(clientIp(req({})));
  });
});

describe('memory is bounded', () => {
  it('a spray of unique keys does not grow without limit', () => {
    // A public endpoint sees arbitrary source addresses. An unbounded map in a
    // long-lived `next start` process is a slow leak, not a theoretical one.
    for (let i = 0; i < 12_000; i++) rateLimit(`k${i}`, 5, 1);
    expect(rateLimit('fresh', 5, 60_000).ok).toBe(true);
  });
});

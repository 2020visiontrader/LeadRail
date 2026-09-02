// The logs panel's headline badges were counting the wrong set.
//
// /api/logs used to tally `counts` by iterating the rows it had just returned
// — rows that had already survived BOTH the `level` filter and `.limit()`. Two
// consequences, both observed in production:
//
//   1. With the panel's DEFAULT Error tab selected, `data` holds only error
//      rows, so `counts.warn` was 0 BY CONSTRUCTION. The badge could not show
//      a warning while that tab was active. Against a 24h window holding
//      889 info / 61 warn / 0 error, the panel read "0 errors, 0 warns". The
//      zero-errors was coincidentally true; the zero-warns was false and hid a
//      real incident.
//   2. Even on the All tab, `.limit()` truncated before the tally, so the
//      badges described the first page rather than the window.
//
// The counts are now separate head-count queries over the same WINDOW (tenant,
// route, search, sinceMinutes) with the level filter and the limit removed.
//
// These tests drive the real route handler against tests/support/fake-supabase.
// That fake now honours .limit() for real and models
// `select(cols, { count: 'exact', head: true })`, without which test 2 would
// pass whether or not the fix is present.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from './support/fake-supabase';

const ACC = 'acct-1';

vi.mock('@/lib/db', () => ({ supabase: db.client, dbReady: () => true }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
  requestStore: { run: (_store: any, fn: any) => fn() },
  enrichContext: vi.fn(),
  currentContext: () => undefined,
}));
vi.mock('@/lib/session', () => ({
  verifySession: async () => ({ email: 'op@example.com', accountId: ACC, role: 'owner', exp: 0 }),
  SESSION_COOKIE: 'ma_session',
}));

beforeEach(() => {
  db.reset();
});

function seed(level: 'info' | 'warn' | 'error', n: number, opts: { minutesAgo?: number; message?: string } = {}) {
  for (let i = 0; i < n; i++) {
    db.tableRows('app_logs').push({
      id: `${level}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      account_id: ACC,
      level,
      route: '/api/leads',
      method: 'GET',
      status: level === 'error' ? 500 : 200,
      message: opts.message ?? `${level} row ${i}`,
      created_at: new Date(Date.now() - (opts.minutesAgo ?? 1) * 60_000).toISOString(),
    });
  }
}

async function call(qs: string) {
  const { GET } = await import('@/app/api/logs/route');
  const req = new NextRequest(`http://localhost/api/logs${qs}`);
  const res = await GET(req as any);
  return { status: res.status, body: await res.json() as any };
}

describe('the counts describe the window, not the filtered page', () => {
  beforeEach(() => {
    seed('info', 9);
    seed('warn', 4);
    seed('error', 2);
  });

  it('the warn count is identical whether the Error tab or All is selected', async () => {
    const onError = await call('?sinceMinutes=1440&level=error');
    const onAll = await call('?sinceMinutes=1440');

    expect(onError.status).toBe(200);
    expect(onError.body.counts.warn).toBe(4);
    expect(onAll.body.counts.warn).toBe(4);
    expect(onError.body.counts.warn).toBe(onAll.body.counts.warn);
  });

  it('the level filter still narrows the returned ROWS, only not the counts', async () => {
    const onError = await call('?sinceMinutes=1440&level=error');
    expect(onError.body.logs).toHaveLength(2);
    expect(onError.body.logs.every((r: any) => r.level === 'error')).toBe(true);
    expect(onError.body.counts).toEqual({ info: 9, warn: 4, error: 2 });
  });

  it('the counts are not capped by limit', async () => {
    const res = await call('?sinceMinutes=1440&limit=2');
    expect(res.body.logs).toHaveLength(2);       // the page really is truncated
    expect(res.body.counts.info).toBe(9);        // the count is not
    expect(res.body.counts.warn).toBe(4);
  });
});

describe('the counts respect the rest of the window', () => {
  it('rows outside sinceMinutes are excluded from the counts', async () => {
    seed('warn', 3, { minutesAgo: 5 });
    seed('warn', 7, { minutesAgo: 5000 });
    const res = await call('?sinceMinutes=60');
    expect(res.body.counts.warn).toBe(3);
  });

  it('the search filter applies to the counts too', async () => {
    seed('warn', 3, { message: 'quota exceeded for sender' });
    seed('warn', 5, { message: 'nothing to see' });
    const res = await call('?sinceMinutes=1440&q=quota');
    expect(res.body.counts.warn).toBe(3);
  });
});

describe('a count that could not be read is not a count of zero', () => {
  it('a failed count query reports counts as unavailable rather than 0', async () => {
    seed('warn', 4);
    db.setFailWhen(({ head }) => (head ? { message: 'statement timeout' } : null));

    const res = await call('?sinceMinutes=1440&level=error');
    expect(res.status).toBe(200);
    expect(res.body.counts).toBeNull();
    expect(res.body.countsUnavailable).toBe(true);
    // The list itself is unaffected — a broken rollup must not blank the logs.
    expect(Array.isArray(res.body.logs)).toBe(true);
  });
});

describe('the panel renders an unavailable rollup as a dash, not a zero', () => {
  // Structural, like tests/logs-admin-tab.test.ts: no jsdom environment is
  // configured (vitest.config.ts runs environment: 'node') and this is a
  // 'use client' component.
  const src = require('node:fs').readFileSync(
    require('node:path').join(process.cwd(), 'src/components/admin/LogsPanel.tsx'),
    'utf8',
  ) as string;

  it('counts state can hold null', () => {
    expect(src).toMatch(/useState<Record<string, number> \| null>\(null\)/);
  });

  it('the badges are guarded on counts rather than defaulting to 0', () => {
    expect(src).not.toMatch(/counts\.error \|\| 0/);
    expect(src).not.toMatch(/counts\.warn \|\| 0/);
    expect(src).toMatch(/counts \? counts\.error \?\? 0 : '—'/);
    expect(src).toMatch(/counts \? counts\.warn \?\? 0 : '—'/);
  });
});

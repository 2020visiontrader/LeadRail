// tests/content-export-route.test.ts — GET /api/content/export must not
// export another tenant's content calendar.
//
// The route previously exported whatever `brandId` arrived in the query
// string with no ownership check at all — the codebase already has
// `assertBrandOwned` for exactly this and the route didn't call it. Any
// authenticated user (any tenant) could hand any brandId and receive that
// tenant's content calendar as a CSV download. This proves the fix: no
// session -> 401, a brandId belonging to another account -> 400 with no
// data, and the caller's own brand -> the expected export scoped to it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from './support/fake-supabase';

let sessionAccountId: string | null = 'acct-1';

vi.mock('@/lib/db', () => ({
  supabase: db.client,
  dbReady: () => true,
  assertBrandOwned: async (brandId: string, accountId: string) => {
    const row = db.tableRows('brands').find((b: any) => b.id === brandId);
    return Boolean(row && row.account_id === accountId);
  },
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
  requestStore: { run: (_store: any, fn: any) => fn() },
  enrichContext: vi.fn(),
  currentContext: () => undefined,
}));
vi.mock('@/lib/session', () => ({
  verifySession: async () =>
    sessionAccountId === null ? null : { email: 'op@example.com', accountId: sessionAccountId, role: 'owner', exp: 0 },
  SESSION_COOKIE: 'ma_session',
}));

beforeEach(() => {
  db.reset();
  sessionAccountId = 'acct-1';
  db.tableRows('brands').push(
    { id: 'brand-mine', account_id: 'acct-1', name: 'My Brand', active: true },
    { id: 'brand-theirs', account_id: 'acct-2', name: 'Other Tenant Brand', active: true },
  );
  db.tableRows('content_calendar').push(
    { id: 'post-mine', brand_id: 'brand-mine', account_id: 'acct-1', platform: 'x', post_body: 'mine', scheduled_for: '2026-01-01', status: 'draft', media_urls: null },
    { id: 'post-theirs', brand_id: 'brand-theirs', account_id: 'acct-2', platform: 'x', post_body: 'theirs, private', scheduled_for: '2026-01-01', status: 'draft', media_urls: null },
  );
});

function req(brandId: string | null) {
  const url = new URL('http://localhost/api/content/export');
  if (brandId) url.searchParams.set('brandId', brandId);
  return new NextRequest(url);
}

describe('GET /api/content/export', () => {
  it('401s with no session', async () => {
    sessionAccountId = null;
    const { GET } = await import('@/app/api/content/export/route');
    const res = await GET(req('brand-mine'));
    expect(res.status).toBe(401);
  });

  it('400s when brandId is missing', async () => {
    const { GET } = await import('@/app/api/content/export/route');
    const res = await GET(req(null));
    expect(res.status).toBe(400);
  });

  it('refuses a brandId owned by another tenant — no data leaks', async () => {
    const { GET } = await import('@/app/api/content/export/route');
    const res = await GET(req('brand-theirs'));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('theirs, private');
  });

  it('exports the caller\'s own brand\'s content as CSV', async () => {
    const { GET } = await import('@/app/api/content/export/route');
    const res = await GET(req('brand-mine'));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('mine');
    expect(text).not.toContain('theirs, private');
  });
});

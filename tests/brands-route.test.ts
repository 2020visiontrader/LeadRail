// tests/brands-route.test.ts — GET /api/brands must not read across tenants.
//
// The route previously had no session read and no account_id filter at all:
// `supabase.from('brands').select('*').eq('active', true)` — any authenticated
// user (any tenant) got every tenant's active brands back. This proves the
// fix: no session -> 401, and a session's list is scoped to that session's
// own account_id, never to another tenant's rows.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from './support/fake-supabase';

let sessionAccountId: string | null = 'acct-1';

vi.mock('@/lib/db', () => ({ supabase: db.client, dbReady: () => true }));
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
    { id: 'brand-mine-inactive', account_id: 'acct-1', name: 'Retired', active: false },
  );
});

function getRequest() {
  return new NextRequest('http://localhost/api/brands');
}

describe('GET /api/brands', () => {
  it('401s with no session', async () => {
    sessionAccountId = null;
    const { GET } = await import('@/app/api/brands/route');
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
  });

  it('returns only the caller\'s own account\'s active brands, never another tenant\'s', async () => {
    const { GET } = await import('@/app/api/brands/route');
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.map((b: any) => b.id);
    expect(ids).toEqual(['brand-mine']);
    expect(ids).not.toContain('brand-theirs');
  });

  it('a different tenant session sees only its own brand', async () => {
    sessionAccountId = 'acct-2';
    const { GET } = await import('@/app/api/brands/route');
    const res = await GET(getRequest());
    const body = await res.json();
    expect(body.map((b: any) => b.id)).toEqual(['brand-theirs']);
  });
});

// tests/connection-token.test.ts — lib/social/connection-token.ts, the
// chokepoint every OAuth-token reader for integration_connections now goes
// through, plus the writers (OAuth callbacks, the pasted-token validate
// route, and the client-writable POST /api/integrations) that must never put
// a token key into `meta` again.
//
// No real DB, no network: integration_connections is an in-memory fake of
// the Supabase query builder (same pattern as tests/gmail-connection.test.ts
// makeFakeDb), extended with order()/upsert()/range() for the operations
// getConnection/getConnections/upsertConnection and the lazy-migration
// update-by-id actually issue.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// --- in-memory fake Supabase client ----------------------------------------
//
// Built entirely inside vi.hoisted(): vi.mock('@/lib/db', factory) below is
// hoisted above ordinary top-level statements (and so is the static import of
// lib/social/connection-token.ts, which imports '@/lib/db' immediately), so
// anything the factory reads — TABLES, makeFakeDb(), fakeSupabase — has to
// already exist by the time that hoisted factory runs. vi.hoisted() runs its
// callback in that same hoisted position, which is what makes that safe.
const { TABLES, resetTables, getFakeSupabase } = vi.hoisted(() => {
  let tables: Record<string, any[]> = {};
  let idCounter = 0;

  function makeFakeDb() {
    return {
    from(table: string) {
      const filters: Array<{ col: string; val: any }> = [];
      let selectCols: string | null = null;
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitN: number | null = null;
      let pendingInsert: any[] | null = null;
      let pendingUpdate: Record<string, any> | null = null;
      let pendingUpsert: any[] | null = null;
      let upsertConflictCols: string[] | null = null;

      function rowsAfterFilters(rows: any[]) {
        return rows.filter((r) => filters.every((f) => r[f.col] === f.val));
      }
      function project(rows: any[]) {
        if (!selectCols || selectCols === '*') return rows;
        const cols = selectCols.split(',').map((c) => c.trim());
        return rows.map((r) => {
          const out: Record<string, any> = {};
          for (const c of cols) out[c] = r[c];
          return out;
        });
      }

      function exec(): { data: any; error: any } {
        tables[table] = tables[table] || [];

        if (pendingUpsert) {
          const conflictCols = upsertConflictCols || ['id'];
          const results: any[] = [];
          for (const r of pendingUpsert) {
            const idx = tables[table].findIndex((existing) =>
              conflictCols.every((c) => existing[c] === r[c]),
            );
            if (idx >= 0) {
              const merged = { ...tables[table][idx], ...r };
              tables[table][idx] = merged;
              results.push(merged);
            } else {
              const created = {
                id: `row-${++idCounter}`,
                created_at: new Date().toISOString(),
                ...r,
              };
              tables[table].push(created);
              results.push(created);
            }
          }
          return { data: project(results), error: null };
        }
        if (pendingInsert) {
          const created = pendingInsert.map((r) => ({
            id: `row-${++idCounter}`,
            created_at: new Date().toISOString(),
            ...r,
          }));
          tables[table] = [...tables[table], ...created];
          return { data: project(created), error: null };
        }
        if (pendingUpdate) {
          const updated: any[] = [];
          tables[table] = tables[table].map((r) => {
            if (rowsAfterFilters([r]).length) {
              const merged = { ...r, ...pendingUpdate };
              updated.push(merged);
              return merged;
            }
            return r;
          });
          return { data: project(updated), error: null };
        }
        let rows = rowsAfterFilters(tables[table]);
        if (orderCol) {
          rows = [...rows].sort((a, b) => {
            const av = a[orderCol as string];
            const bv = b[orderCol as string];
            if (av === bv) return 0;
            return orderAsc ? (av > bv ? 1 : -1) : av < bv ? 1 : -1;
          });
        }
        if (limitN != null) rows = rows.slice(0, limitN);
        return { data: project(rows), error: null };
      }

      const builder: any = {
        select(cols: string) {
          selectCols = cols;
          return builder;
        },
        eq(col: string, val: any) {
          filters.push({ col, val });
          return builder;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
          return builder;
        },
        limit(n: number) {
          limitN = n;
          return builder;
        },
        insert(rows: any[]) {
          pendingInsert = rows;
          return builder;
        },
        update(patch: Record<string, any>) {
          pendingUpdate = patch;
          return builder;
        },
        upsert(rows: any, opts?: { onConflict?: string }) {
          pendingUpsert = Array.isArray(rows) ? rows : [rows];
          upsertConflictCols = opts?.onConflict ? opts.onConflict.split(',') : null;
          return builder;
        },
        async maybeSingle() {
          const { data, error } = exec();
          return { data: (data as any[])[0] ?? null, error };
        },
        async single() {
          const { data, error } = exec();
          if (!(data as any[]).length) return { data: null, error: { message: 'no rows', code: 'PGRST116' } };
          return { data: (data as any[])[0], error };
        },
        then(resolve: any, reject: any) {
          return Promise.resolve(exec()).then(resolve, reject);
        },
      };
      return builder;
      },
    };
  }

  let fakeSupabase: any = null;
  return {
    TABLES: tables,
    resetTables: () => {
      for (const k of Object.keys(tables)) delete tables[k];
      idCounter = 0;
    },
    getFakeSupabase: () => {
      if (!fakeSupabase) fakeSupabase = makeFakeDb();
      return fakeSupabase;
    },
  };
});

// Mirrors the real lib/db.ts implementations, pointed at the fake client —
// mocking the whole module (needed to avoid a real Supabase client trying to
// hit the network) but keeping identical query shapes so connection-token.ts
// exercises the same code paths it does in production.
vi.mock('@/lib/db', () => ({
  supabase: getFakeSupabase(),
  dbReady: () => true,
  getConnection: async (accountId: string, provider: string, externalId?: string) => {
    let q = getFakeSupabase()
      .from('integration_connections')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', provider)
      .eq('status', 'connected');
    if (externalId) q = q.eq('external_id', externalId);
    const { data, error } = await q.order('updated_at', { ascending: false }).limit(1);
    if (error) throw error;
    return data?.[0] ?? null;
  },
  getConnections: async (accountId: string) => {
    const { data, error } = await getFakeSupabase()
      .from('integration_connections')
      .select('*')
      .eq('account_id', accountId)
      .order('provider', { ascending: true });
    if (error) throw error;
    return data;
  },
  upsertConnection: async (row: Record<string, any>) => {
    const payload: Record<string, any> = {
      account_id: row.account_id,
      provider: row.provider,
      external_id: row.external_id ?? row.provider,
      display_name: row.display_name ?? null,
      username: row.username ?? null,
      status: row.status ?? 'connected',
      secret_ref: row.secret_ref ?? null,
      meta: row.meta ?? {},
      updated_at: new Date().toISOString(),
    };
    if (row.secret_encrypted !== undefined) payload.secret_encrypted = row.secret_encrypted;
    const { data, error } = await getFakeSupabase()
      .from('integration_connections')
      .upsert(payload, { onConflict: 'account_id,provider,external_id' })
      .select();
    if (error) throw error;
    return data[0];
  },
}));

beforeEach(() => {
  resetTables();
  seedIdCounter = 0;
  process.env.AI_VAULT_KEY = 'test-vault-key-for-connection-token-suite';
});

afterEach(() => {
  delete process.env.AI_VAULT_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

const ACCOUNT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACCOUNT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

import {
  resolveConnectionTokens,
  resolveTokensForRow,
  stripTokenKeys,
  encryptTokenBundle,
} from '@/lib/social/connection-token';
import { decryptSecret } from '@/lib/ai/crypto';

let seedIdCounter = 0;

function seedConnection(row: Record<string, any>) {
  TABLES['integration_connections'] = TABLES['integration_connections'] || [];
  const created = {
    id: `seed-row-${++seedIdCounter}`,
    status: 'connected',
    meta: {},
    secret_encrypted: null,
    secret_ref: null,
    updated_at: new Date().toISOString(),
    ...row,
  };
  TABLES['integration_connections'].push(created);
  return created;
}

// ---------------------------------------------------------------------------
// The accessor's read contract.
// ---------------------------------------------------------------------------
describe('resolveConnectionTokens / resolveTokensForRow', () => {
  it('reader with only secret_encrypted returns the token', async () => {
    seedConnection({
      account_id: ACCOUNT_A,
      provider: 'notion',
      external_id: 'notion',
      secret_encrypted: encryptTokenBundle({ access_token: 'ntn_real_secret' }),
      meta: { platform_name: 'My Workspace' },
    });

    const tokens = await resolveConnectionTokens(ACCOUNT_A, 'notion');
    expect(tokens.accessToken).toBe('ntn_real_secret');
    expect(tokens.refreshToken).toBeNull();
  });

  it('reader with only plaintext meta returns it AND migrates it (secret_encrypted populated, meta keys gone)', async () => {
    const row = seedConnection({
      account_id: ACCOUNT_A,
      provider: 'instagram',
      external_id: 'ig-1',
      meta: { access_token: 'plaintext-ig-token', ig_user_id: 'ig-1', ig_username: 'acme' },
    });

    const tokens = await resolveConnectionTokens(ACCOUNT_A, 'instagram');
    expect(tokens.accessToken).toBe('plaintext-ig-token');

    const stored = TABLES['integration_connections'].find((r) => r.id === row.id);
    expect(stored.secret_encrypted).toBeTruthy();
    expect(stored.secret_encrypted).not.toContain('plaintext-ig-token');
    expect(decryptSecret(stored.secret_encrypted)).toContain('plaintext-ig-token');
    expect(stored.meta.access_token).toBeUndefined();
    // Non-secret fields survive the migration untouched.
    expect(stored.meta.ig_user_id).toBe('ig-1');
    expect(stored.meta.ig_username).toBe('acme');
  });

  it('a second read after migration comes from secret_encrypted, not meta (meta has nothing left to fall back to)', async () => {
    seedConnection({
      account_id: ACCOUNT_A,
      provider: 'instagram',
      external_id: 'ig-1',
      meta: { access_token: 'plaintext-ig-token' },
    });
    await resolveConnectionTokens(ACCOUNT_A, 'instagram'); // triggers migration
    const tokens = await resolveConnectionTokens(ACCOUNT_A, 'instagram'); // second read
    expect(tokens.accessToken).toBe('plaintext-ig-token');
  });

  it('failed migration write still returns the token (the caller must not break)', async () => {
    seedConnection({
      account_id: ACCOUNT_A,
      provider: 'notion',
      external_id: 'notion',
      meta: { access_token: 'plaintext-notion-token' },
    });

    // Force the migration UPDATE to fail without touching the read path.
    const db = getFakeSupabase();
    const originalFrom = db.from.bind(db);
    const spy = vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const builder = originalFrom(table);
      const originalUpdate = builder.update.bind(builder);
      builder.update = (patch: any) => {
        const b = originalUpdate(patch);
        const originalEq = b.eq.bind(b);
        b.eq = (...args: any[]) => {
          const bb = originalEq(...args);
          bb.then = (_resolve: any, reject: any) => Promise.reject(new Error('simulated write failure')).catch(reject);
          return bb;
        };
        return b;
      };
      return builder;
    }) as any);

    const tokens = await resolveConnectionTokens(ACCOUNT_A, 'notion');
    expect(tokens.accessToken).toBe('plaintext-notion-token');

    const stored = TABLES['integration_connections'].find((r) => r.provider === 'notion' && r.account_id === ACCOUNT_A);
    expect(stored.secret_encrypted).toBeFalsy();
    expect(stored.meta.access_token).toBe('plaintext-notion-token'); // never partially migrated

    spy.mockRestore();
  });

  it('vault unconfigured does not write pretend-ciphertext', async () => {
    delete process.env.AI_VAULT_KEY;
    const row = seedConnection({
      account_id: ACCOUNT_A,
      provider: 'notion',
      external_id: 'notion',
      meta: { access_token: 'plaintext-notion-token' },
    });

    const tokens = await resolveConnectionTokens(ACCOUNT_A, 'notion');
    expect(tokens.accessToken).toBe('plaintext-notion-token');

    const stored = TABLES['integration_connections'].find((r) => r.id === row.id);
    expect(stored.secret_encrypted).toBeFalsy();
    expect(stored.meta.access_token).toBe('plaintext-notion-token'); // untouched, not "encrypted" under no key
  });

  it('neither secret_encrypted nor a plaintext token present returns a clean null, no throw', async () => {
    seedConnection({
      account_id: ACCOUNT_A,
      provider: 'notion',
      external_id: 'notion',
      meta: { platform_name: 'Workspace only, never connected' },
    });

    const tokens = await resolveConnectionTokens(ACCOUNT_A, 'notion');
    expect(tokens).toEqual({ accessToken: null, refreshToken: null, userToken: null });
  });

  it('no connection row at all returns a clean null, no throw', async () => {
    const tokens = await resolveConnectionTokens(ACCOUNT_A, 'notion');
    expect(tokens).toEqual({ accessToken: null, refreshToken: null, userToken: null });
  });

  it('a malformed/tampered secret_encrypted throws rather than silently degrading', async () => {
    seedConnection({
      account_id: ACCOUNT_A,
      provider: 'notion',
      external_id: 'notion',
      secret_encrypted: 'not-valid-ciphertext',
      meta: {},
    });
    await expect(resolveConnectionTokens(ACCOUNT_A, 'notion')).rejects.toThrow();
  });

  it('cross-account isolation: account B never resolves account A\'s token', async () => {
    seedConnection({
      account_id: ACCOUNT_A,
      provider: 'notion',
      external_id: 'notion',
      secret_encrypted: encryptTokenBundle({ access_token: 'a-secret' }),
    });
    seedConnection({
      account_id: ACCOUNT_B,
      provider: 'notion',
      external_id: 'notion',
      secret_encrypted: encryptTokenBundle({ access_token: 'b-secret' }),
    });

    const forA = await resolveConnectionTokens(ACCOUNT_A, 'notion');
    const forB = await resolveConnectionTokens(ACCOUNT_B, 'notion');
    expect(forA.accessToken).toBe('a-secret');
    expect(forB.accessToken).toBe('b-secret');
  });
});

// ---------------------------------------------------------------------------
// stripTokenKeys / encryptTokenBundle — the small building blocks writers use.
// ---------------------------------------------------------------------------
describe('stripTokenKeys', () => {
  it('drops only the token keys, keeping everything else', () => {
    const out = stripTokenKeys({ access_token: 'x', refresh_token: 'y', user_token: 'z', page_id: 'p1', ig_username: 'acme' });
    expect(out).toEqual({ page_id: 'p1', ig_username: 'acme' });
  });

  it('handles null/undefined meta', () => {
    expect(stripTokenKeys(null)).toEqual({});
    expect(stripTokenKeys(undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Writers: real route handlers, real upsertConnection call, structural
// assertions on the row object — not a source-code grep.
// ---------------------------------------------------------------------------
function capturedUpserts(): any[] {
  return (TABLES['integration_connections'] || []).slice();
}

function assertNoTokenInMeta(row: any) {
  expect(row.meta?.access_token).toBeUndefined();
  expect(row.meta?.refresh_token).toBeUndefined();
  expect(row.meta?.user_token).toBeUndefined();
}

describe('writers never place a token in meta', () => {
  it('facebook + instagram (app/api/social/meta/callback): two Page tokens survive a round trip, still keyed by page id, meta carries no secret', async () => {
    vi.resetModules();
    vi.doMock('@/lib/social/meta-oauth', () => ({
      verifyState: vi.fn(async () => ({ accountId: ACCOUNT_A })),
      exchangeCodeForToken: vi.fn(async () => 'short-code-token'),
      getLongLivedToken: vi.fn(async () => 'long-lived-user-token'),
      getMeId: vi.fn(async () => 'fb-user-1'),
      getUserPages: vi.fn(async () => [
        { id: 'page-1', name: 'Page One', access_token: 'page-1-token', ig_user_id: 'ig-1', ig_username: 'page_one_ig' },
        { id: 'page-2', name: 'Page Two', access_token: 'page-2-token' }, // no linked IG
      ]),
      publicBase: () => 'https://app.example.com',
    }));
    const { GET } = await import('@/app/api/social/meta/callback/route');
    const req = new NextRequest('https://app.example.com/api/social/meta/callback?code=abc&state=st');
    const res = await GET(req as any);
    expect(res.status).toBe(307); // redirect

    const rows = capturedUpserts();
    const fbRows = rows.filter((r) => r.provider === 'facebook');
    const igRows = rows.filter((r) => r.provider === 'instagram');
    expect(fbRows.length).toBe(2);
    expect(igRows.length).toBe(1); // only page-1 had a linked IG account

    for (const r of [...fbRows, ...igRows]) assertNoTokenInMeta(r);

    const page1Fb = fbRows.find((r) => r.external_id === 'page-1');
    const page2Fb = fbRows.find((r) => r.external_id === 'page-2');
    const page1Ig = igRows.find((r) => r.external_id === 'ig-1');

    expect(decryptSecret(page1Fb.secret_encrypted)).toContain('page-1-token');
    expect(decryptSecret(page2Fb.secret_encrypted)).toContain('page-2-token');
    expect(decryptSecret(page1Ig.secret_encrypted)).toContain('page-1-token'); // linked IG uses the SAME Page token
    // Distinct pages keep distinct tokens — no cross-page bleed.
    expect(decryptSecret(page1Fb.secret_encrypted)).not.toContain('page-2-token');
    expect(page1Ig.meta.via_page_id).toBe('page-1'); // per-page association preserved via meta, non-secret
  });

  it('google_drive (app/api/social/google-drive/callback): access + refresh token never land in meta', async () => {
    vi.resetModules();
    vi.doMock('@/lib/social/google-oauth', () => ({
      verifyState: vi.fn(async () => ({ accountId: ACCOUNT_A })),
      exchangeGoogleCode: vi.fn(async () => ({ accessToken: 'gdrive-access', refreshToken: 'gdrive-refresh', expiresIn: 3600 })),
      getGoogleEmail: vi.fn(async () => 'user@example.com'),
    }));
    vi.doMock('@/lib/social/meta-oauth', () => ({ publicBase: () => 'https://app.example.com' }));
    const { GET } = await import('@/app/api/social/google-drive/callback/route');
    const req = new NextRequest('https://app.example.com/api/social/google-drive/callback?code=abc&state=st');
    const res = await GET(req as any);
    expect(res.status).toBe(307);

    const rows = capturedUpserts().filter((r) => r.provider === 'google_drive');
    expect(rows.length).toBe(1);
    assertNoTokenInMeta(rows[0]);
    expect(rows[0].meta.email).toBe('user@example.com');
    const bundle = JSON.parse(decryptSecret(rows[0].secret_encrypted));
    expect(bundle.access_token).toBe('gdrive-access');
    expect(bundle.refresh_token).toBe('gdrive-refresh');
  });

  it('instagram login (app/api/social/instagram/callback): token never lands in meta', async () => {
    vi.resetModules();
    vi.doMock('@/lib/social/instagram-oauth', () => ({
      verifyState: vi.fn(async () => ({ accountId: ACCOUNT_A })),
      exchangeIgCode: vi.fn(async () => ({ token: 'ig-short', userId: 'ig-1' })),
      getLongLivedIgToken: vi.fn(async () => 'ig-long-lived'),
      getIgProfile: vi.fn(async () => ({ id: 'ig-1', username: 'acme' })),
    }));
    vi.doMock('@/lib/social/meta-oauth', () => ({ publicBase: () => 'https://app.example.com' }));
    const { GET } = await import('@/app/api/social/instagram/callback/route');
    const req = new NextRequest('https://app.example.com/api/social/instagram/callback?code=abc&state=st');
    await GET(req as any);

    const rows = capturedUpserts().filter((r) => r.provider === 'instagram');
    expect(rows.length).toBe(1);
    assertNoTokenInMeta(rows[0]);
    expect(decryptSecret(rows[0].secret_encrypted)).toContain('ig-long-lived');
  });

  it('tiktok (app/api/social/tiktok/callback): access + refresh token never land in meta', async () => {
    vi.resetModules();
    vi.doMock('@/lib/social/tiktok-oauth', () => ({
      PKCE_COOKIE: 'tiktok_pkce_verifier',
      verifyState: vi.fn(async () => ({ accountId: ACCOUNT_A })),
      exchangeTiktokCode: vi.fn(async () => ({ token: 'tt-access', refreshToken: 'tt-refresh', openId: 'tt-1', expiresIn: 3600 })),
      getTiktokProfile: vi.fn(async () => ({ id: 'tt-1', username: 'acme' })),
    }));
    vi.doMock('@/lib/social/meta-oauth', () => ({ publicBase: () => 'https://app.example.com' }));
    const { GET } = await import('@/app/api/social/tiktok/callback/route');
    const req = new NextRequest('https://app.example.com/api/social/tiktok/callback?code=abc&state=st', {
      headers: { cookie: 'tiktok_pkce_verifier=verifier123' },
    });
    await GET(req as any);

    const rows = capturedUpserts().filter((r) => r.provider === 'tiktok');
    expect(rows.length).toBe(1);
    assertNoTokenInMeta(rows[0]);
    const bundle = JSON.parse(decryptSecret(rows[0].secret_encrypted));
    expect(bundle.access_token).toBe('tt-access');
    expect(bundle.refresh_token).toBe('tt-refresh');
  });

  it('x (app/api/social/x/callback): access + refresh token never land in meta', async () => {
    vi.resetModules();
    vi.doMock('@/lib/social/x-oauth', () => ({
      PKCE_COOKIE: 'x_pkce_verifier',
      verifyState: vi.fn(async () => ({ accountId: ACCOUNT_A })),
      exchangeXCode: vi.fn(async () => ({ token: 'x-access', refreshToken: 'x-refresh', expiresIn: 3600 })),
      getXProfile: vi.fn(async () => ({ id: 'x-1', username: 'acme' })),
    }));
    vi.doMock('@/lib/social/meta-oauth', () => ({ publicBase: () => 'https://app.example.com' }));
    const { GET } = await import('@/app/api/social/x/callback/route');
    const req = new NextRequest('https://app.example.com/api/social/x/callback?code=abc&state=st', {
      headers: { cookie: 'x_pkce_verifier=verifier123' },
    });
    await GET(req as any);

    const rows = capturedUpserts().filter((r) => r.provider === 'x');
    expect(rows.length).toBe(1);
    assertNoTokenInMeta(rows[0]);
  });

  it('linkedin (app/api/social/linkedin/callback): token never lands in meta', async () => {
    vi.resetModules();
    vi.doMock('@/lib/social/linkedin-oauth', () => ({
      verifyState: vi.fn(async () => ({ accountId: ACCOUNT_A })),
      exchangeLinkedinCode: vi.fn(async () => ({ token: 'li-access', expiresIn: 3600 })),
      getLinkedinProfile: vi.fn(async () => ({ id: 'li-1', name: 'Acme Co' })),
    }));
    vi.doMock('@/lib/social/meta-oauth', () => ({ publicBase: () => 'https://app.example.com' }));
    const { GET } = await import('@/app/api/social/linkedin/callback/route');
    const req = new NextRequest('https://app.example.com/api/social/linkedin/callback?code=abc&state=st');
    await GET(req as any);

    const rows = capturedUpserts().filter((r) => r.provider === 'linkedin');
    expect(rows.length).toBe(1);
    assertNoTokenInMeta(rows[0]);
    expect(rows[0].meta.member_id).toBe('li-1'); // non-secret id stays in meta
  });

  it('threads (app/api/social/threads/callback): token never lands in meta', async () => {
    vi.resetModules();
    vi.doMock('@/lib/social/threads-oauth', () => ({
      verifyState: vi.fn(async () => ({ accountId: ACCOUNT_A })),
      exchangeThreadsCode: vi.fn(async () => ({ token: 'th-short', userId: 'th-1' })),
      getLongLivedThreadsToken: vi.fn(async () => 'th-long-lived'),
      getThreadsProfile: vi.fn(async () => ({ id: 'th-1', username: 'acme' })),
    }));
    vi.doMock('@/lib/social/meta-oauth', () => ({ publicBase: () => 'https://app.example.com' }));
    const { GET } = await import('@/app/api/social/threads/callback/route');
    const req = new NextRequest('https://app.example.com/api/social/threads/callback?code=abc&state=st');
    await GET(req as any);

    const rows = capturedUpserts().filter((r) => r.provider === 'threads');
    expect(rows.length).toBe(1);
    assertNoTokenInMeta(rows[0]);
  });

  it('POST /api/integrations strips a client-supplied token key from meta rather than storing it', async () => {
    vi.resetModules();
    vi.doMock('@/lib/session', () => ({
      SESSION_COOKIE: 'leadrail_session',
      verifySession: vi.fn(async () => ({ accountId: ACCOUNT_A, role: 'member', email: 'owner@example.com' })),
    }));
    const { POST } = await import('@/app/api/integrations/route');
    const req = new NextRequest('https://app.example.com/api/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'leadrail_session=whatever' },
      body: JSON.stringify({
        provider: 'evil',
        meta: { access_token: 'sneaky-token', display_hint: 'kept' },
      }),
    });
    await POST(req as any);

    const rows = capturedUpserts().filter((r) => r.provider === 'evil');
    expect(rows.length).toBe(1);
    assertNoTokenInMeta(rows[0]);
    expect(rows[0].meta.display_hint).toBe('kept');
  });
});

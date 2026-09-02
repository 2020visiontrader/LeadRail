// tests/gmail-connection.test.ts — Gmail connection (migrations/081, and
// lib/email/{gmail,gmail-account}.ts).
//
// PRODUCT RULE UNDER TEST (2026-09-02 correction): exactly ONE connected
// Gmail row per account. There is no "active" concept — connecting a second
// address while one is already connected must be refused, cleanly, naming
// the address already connected. The database-level half of that guarantee
// (the partial unique index in migrations/081_gmail_accounts.sql) was
// verified separately against a real local Postgres — see the PR/session
// report. This file covers the application-layer half plus the parts a real
// DB can't exercise in this vitest suite (no live DB here — see
// vitest.config.ts): encrypt/decrypt round-trip, the browser-facing
// allowlist projection, address-casing normalisation, cross-account
// isolation, a revoked refresh token degrading to status='error' instead of
// throwing, and reply-send's ownership gate now finding a real row.
//
// No real DB, no network: email_accounts is an in-memory fake of the
// Supabase query builder (see makeFakeDb), following the same pattern as
// tests/account-export.test.ts's makeExportClient. global.fetch is stubbed
// for the Google token-refresh test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- in-memory fake Supabase client ----------------------------------------
let TABLES: Record<string, any[]> = {};
let idCounter = 0;

function makeFakeDb() {
  return {
    from(table: string) {
      const filters: Array<{ col: string; op: 'eq' | 'ilike'; val: any }> = [];
      let selectCols: string | null = null;
      let limitN: number | null = null;
      let pendingInsert: any[] | null = null;
      let pendingUpdate: Record<string, any> | null = null;

      function rowsAfterFilters(rows: any[]) {
        return rows.filter((r) =>
          filters.every((f) =>
            f.op === 'ilike'
              ? String(r[f.col] ?? '').toLowerCase() === String(f.val).toLowerCase()
              : r[f.col] === f.val,
          ),
        );
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
        TABLES[table] = TABLES[table] || [];
        if (pendingInsert) {
          const created = pendingInsert.map((r) => ({
            id: `row-${++idCounter}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...r,
          }));
          TABLES[table] = [...TABLES[table], ...created];
          return { data: project(created), error: null };
        }
        if (pendingUpdate) {
          let updated: any[] = [];
          TABLES[table] = TABLES[table].map((r) => {
            if (rowsAfterFilters([r]).length) {
              const merged = { ...r, ...pendingUpdate };
              updated.push(merged);
              return merged;
            }
            return r;
          });
          return { data: project(updated), error: null };
        }
        let rows = rowsAfterFilters(TABLES[table]);
        if (limitN != null) rows = rows.slice(0, limitN);
        return { data: project(rows), error: null };
      }

      const builder: any = {
        select(cols: string) {
          selectCols = cols;
          return builder;
        },
        eq(col: string, val: any) {
          filters.push({ col, op: 'eq', val });
          return builder;
        },
        ilike(col: string, val: any) {
          filters.push({ col, op: 'ilike', val });
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

vi.mock('@/lib/db', () => ({ supabase: makeFakeDb(), dbReady: () => true }));

const ACCOUNT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACCOUNT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

beforeEach(() => {
  TABLES = {};
  idCounter = 0;
  process.env.AI_VAULT_KEY = 'test-vault-key-for-gmail-connection-suite';
});

afterEach(() => {
  delete process.env.AI_VAULT_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import { encryptSecret, decryptSecret } from '@/lib/ai/crypto';
import {
  connectGmailAccount,
  getGmailAccount,
  disconnectGmailAccount,
  markGmailAccountError,
  safeGmailAccount,
  normalizeAddress,
  GmailAlreadyConnectedError,
  type GmailAccountRow,
} from '@/lib/email/gmail-account';
import { mintAccessToken } from '@/lib/email/gmail';

// ---------------------------------------------------------------------------
// Encrypt/decrypt round-trip + never in the list projection.
// ---------------------------------------------------------------------------
describe('refresh token storage', () => {
  it('round-trips through encryptSecret/decryptSecret', () => {
    const token = '1//0gRefreshTokenExample-abc123';
    const encrypted = encryptSecret(token);
    expect(encrypted).not.toContain(token);
    expect(decryptSecret(encrypted)).toBe(token);
  });

  it('connectGmailAccount stores only ciphertext, never the plaintext token, in secret_encrypted', async () => {
    const row = await connectGmailAccount({
      accountId: ACCOUNT_A,
      address: 'bob@x.com',
      refreshToken: 'plain-refresh-token-xyz',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      expiresInSec: 3600,
    });
    expect(row.secret_encrypted).toBeTruthy();
    expect(row.secret_encrypted).not.toContain('plain-refresh-token-xyz');
    expect(decryptSecret(row.secret_encrypted!)).toBe('plain-refresh-token-xyz');
  });

  it('is never returned by the allowlist projection (safeGmailAccount)', async () => {
    const row = await connectGmailAccount({
      accountId: ACCOUNT_A,
      address: 'bob@x.com',
      refreshToken: 'plain-refresh-token-xyz',
      scopes: [],
      expiresInSec: 3600,
    });
    const projected = safeGmailAccount(row);
    expect(projected).not.toHaveProperty('secret_encrypted');
    expect(projected).not.toHaveProperty('secret_ref');
    expect(JSON.stringify(projected)).not.toContain('plain-refresh-token-xyz');
  });
});

// ---------------------------------------------------------------------------
// Allowlist projection shape — asserted on the actual response shape, not by
// re-deriving what "should" be dropped.
// ---------------------------------------------------------------------------
describe('safeGmailAccount allowlist projection', () => {
  it('exposes exactly the allowed fields and drops secret_encrypted, secret_ref, and any raw meta-shaped field', () => {
    const row: GmailAccountRow = {
      id: 'row-1',
      account_id: ACCOUNT_A,
      provider: 'gmail',
      address: 'bob@x.com',
      status: 'connected',
      secret_ref: 'user-oauth:gmail',
      secret_encrypted: encryptSecret('super-secret-refresh-token'),
      token_expires_at: '2026-09-02T12:00:00.000Z',
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      last_error: null,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    };
    const projected = safeGmailAccount(row);
    expect(Object.keys(projected).sort()).toEqual(
      ['address', 'connected_at', 'id', 'last_error', 'provider', 'scopes', 'status', 'updated_at'].sort(),
    );
    expect(projected).toEqual({
      id: 'row-1',
      provider: 'gmail',
      address: 'bob@x.com',
      status: 'connected',
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      last_error: null,
      connected_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// Address casing.
// ---------------------------------------------------------------------------
describe('address casing', () => {
  it('normalizeAddress lowercases and trims', () => {
    expect(normalizeAddress('  Bob@X.com  ')).toBe('bob@x.com');
  });

  it('connecting Bob@x.com then bob@x.com yields ONE row (second is refused, naming the first)', async () => {
    await connectGmailAccount({
      accountId: ACCOUNT_A,
      address: 'Bob@X.com',
      refreshToken: 'rt-1',
      scopes: [],
      expiresInSec: 3600,
    });

    await expect(
      connectGmailAccount({
        accountId: ACCOUNT_A,
        address: 'bob@x.com',
        refreshToken: 'rt-2',
        scopes: [],
        expiresInSec: 3600,
      }),
    ).rejects.toBeInstanceOf(GmailAlreadyConnectedError);

    const rows = (TABLES['email_accounts'] || []).filter((r) => r.account_id === ACCOUNT_A);
    expect(rows.length).toBe(1);
    expect(rows[0].address).toBe('bob@x.com');
  });
});

// ---------------------------------------------------------------------------
// One-at-a-time refusal (application layer; the DB partial unique index is
// the backstop, verified separately against real Postgres).
// ---------------------------------------------------------------------------
describe('connecting a second Gmail address while one is connected', () => {
  it('is refused with a message naming the existing address', async () => {
    await connectGmailAccount({
      accountId: ACCOUNT_A,
      address: 'first@x.com',
      refreshToken: 'rt-1',
      scopes: [],
      expiresInSec: 3600,
    });

    let caught: GmailAlreadyConnectedError | null = null;
    try {
      await connectGmailAccount({
        accountId: ACCOUNT_A,
        address: 'second@x.com',
        refreshToken: 'rt-2',
        scopes: [],
        expiresInSec: 3600,
      });
    } catch (e) {
      caught = e as GmailAlreadyConnectedError;
    }
    expect(caught).toBeInstanceOf(GmailAlreadyConnectedError);
    expect(caught!.existingAddress).toBe('first@x.com');
    expect(caught!.message).toContain('first@x.com');

    const account = await getGmailAccount(ACCOUNT_A);
    expect(account?.address).toBe('first@x.com');
  });

  it('allows reconnecting after a disconnect, updating the row in place rather than adding a second one', async () => {
    await connectGmailAccount({
      accountId: ACCOUNT_A,
      address: 'first@x.com',
      refreshToken: 'rt-1',
      scopes: [],
      expiresInSec: 3600,
    });
    await disconnectGmailAccount(ACCOUNT_A);

    const reconnected = await connectGmailAccount({
      accountId: ACCOUNT_A,
      address: 'second@x.com',
      refreshToken: 'rt-2',
      scopes: [],
      expiresInSec: 3600,
    });
    expect(reconnected.address).toBe('second@x.com');
    expect(reconnected.status).toBe('connected');

    const rows = (TABLES['email_accounts'] || []).filter((r) => r.account_id === ACCOUNT_A);
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-account isolation.
// ---------------------------------------------------------------------------
describe('cross-account read/write', () => {
  it('getGmailAccount never returns another account\'s row', async () => {
    await connectGmailAccount({ accountId: ACCOUNT_A, address: 'a@x.com', refreshToken: 'rt-a', scopes: [], expiresInSec: 3600 });
    await connectGmailAccount({ accountId: ACCOUNT_B, address: 'b@x.com', refreshToken: 'rt-b', scopes: [], expiresInSec: 3600 });

    const forA = await getGmailAccount(ACCOUNT_A);
    const forB = await getGmailAccount(ACCOUNT_B);
    expect(forA?.address).toBe('a@x.com');
    expect(forB?.address).toBe('b@x.com');
  });

  it('disconnectGmailAccount only touches the calling account\'s row', async () => {
    await connectGmailAccount({ accountId: ACCOUNT_A, address: 'a@x.com', refreshToken: 'rt-a', scopes: [], expiresInSec: 3600 });
    await connectGmailAccount({ accountId: ACCOUNT_B, address: 'b@x.com', refreshToken: 'rt-b', scopes: [], expiresInSec: 3600 });

    await disconnectGmailAccount(ACCOUNT_B);

    const forA = await getGmailAccount(ACCOUNT_A);
    const forB = await getGmailAccount(ACCOUNT_B);
    expect(forA?.status).toBe('connected');
    expect(forA?.secret_encrypted).toBeTruthy();
    expect(forB?.status).toBe('disconnected');
    expect(forB?.secret_encrypted).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Revoked refresh token.
// ---------------------------------------------------------------------------
describe('a revoked refresh token', () => {
  it('sets status=\'error\' with last_error, rather than throwing, from mintAccessToken', async () => {
    await connectGmailAccount({ accountId: ACCOUNT_A, address: 'a@x.com', refreshToken: 'revoked-rt', scopes: [], expiresInSec: 3600 });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: false,
          statusText: 'Bad Request',
          json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
        }) as any,
      ),
    );

    const token = await mintAccessToken(ACCOUNT_A);
    expect(token).toBeNull();

    const row = await getGmailAccount(ACCOUNT_A);
    expect(row?.status).toBe('error');
    expect(row?.last_error).toMatch(/invalid_grant|revoked/i);
  });

  it('markGmailAccountError is scoped to the calling account only', async () => {
    await connectGmailAccount({ accountId: ACCOUNT_A, address: 'a@x.com', refreshToken: 'rt-a', scopes: [], expiresInSec: 3600 });
    await connectGmailAccount({ accountId: ACCOUNT_B, address: 'b@x.com', refreshToken: 'rt-b', scopes: [], expiresInSec: 3600 });

    await markGmailAccountError(ACCOUNT_A, 'boom');

    const forA = await getGmailAccount(ACCOUNT_A);
    const forB = await getGmailAccount(ACCOUNT_B);
    expect(forA?.status).toBe('error');
    expect(forB?.status).toBe('connected');
  });
});

// ---------------------------------------------------------------------------
// reply-send's ownership gate — now finds a real row instead of an
// eternally-empty table.
// ---------------------------------------------------------------------------
vi.mock('@/lib/integrations/resend', () => ({
  sendPlatformEmail: vi.fn(async () => ({ id: 'resend-msg-1' })),
}));

describe('reply-send ownership check', () => {
  it('passes for an address this account owns via a connected Gmail row', async () => {
    const { sendInboxReply } = await import('@/lib/inbox/reply-send');
    await connectGmailAccount({ accountId: ACCOUNT_A, address: 'me@x.com', refreshToken: 'rt', scopes: [], expiresInSec: 3600 });
    TABLES['inbox_messages'] = [
      {
        id: 'msg-1',
        account_id: ACCOUNT_A,
        from_addr: 'lead@prospect.com',
        to_addr: 'me@x.com',
        thread_id: 't1',
        contact_id: null,
      },
    ];

    const result = await sendInboxReply({
      accountId: ACCOUNT_A,
      inboxMessageId: 'msg-1',
      subject: 'Hello',
      bodyHtml: '<p>hi</p>',
    });
    expect(result.sent).toBe(true);
    expect(result.from).toBe('me@x.com');
  });

  it('still refuses an address this account does not own', async () => {
    const { sendInboxReply } = await import('@/lib/inbox/reply-send');
    // No email_accounts row for unowned@x.com at all.
    TABLES['inbox_messages'] = [
      {
        id: 'msg-2',
        account_id: ACCOUNT_A,
        from_addr: 'lead@prospect.com',
        to_addr: 'unowned@x.com',
        thread_id: 't2',
        contact_id: null,
      },
    ];

    await expect(
      sendInboxReply({ accountId: ACCOUNT_A, inboxMessageId: 'msg-2', subject: 'Hello', bodyHtml: '<p>hi</p>' }),
    ).rejects.toThrow(/not owned by account/);
  });
});

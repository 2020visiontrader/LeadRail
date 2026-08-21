// tests/signup-route.test.ts — public account creation.
//
// A new account can reach capabilities that spend real money (ad budget,
// sourcing credits), so this route is gated by default and every property below
// is about not giving something away for free: not accounts, and not the answer
// to "does this person have one".

import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({
  members: [] as any[],
  accounts: [] as any[],
  failMemberInsert: false,
}));

vi.mock('@/lib/db', () => {
  const q = (table: string) => {
    const rows = () => (table === 'account_members' ? db.members : db.accounts);
    const builder: any = {
      _f: [] as [string, any][],
      select() { return builder; },
      eq(c: string, v: any) { builder._f.push([c, v]); return builder; },
      async maybeSingle() {
        const r = rows().find((x: any) => builder._f.every(([c, v]: [string, any]) => x[c] === v));
        builder._f = [];
        return { data: r ?? null, error: null };
      },
      insert(row: any) {
        const one = Array.isArray(row) ? row[0] : row;
        if (table === 'account_members') {
          if (db.failMemberInsert) return { select: () => ({ single: async () => ({ data: null, error: { message: 'boom' } }) }), then: (r: any) => r({ error: { message: 'boom' } }) };
          db.members.push({ ...one });
          return { select: () => ({ single: async () => ({ data: one, error: null }) }), then: (r: any) => r({ error: null }) };
        }
        const rec = { id: `acct_${db.accounts.length + 1}`, ...one };
        db.accounts.push(rec);
        return { select: () => ({ single: async () => ({ data: rec, error: null }) }), then: (r: any) => r({ error: null }) };
      },
      delete() {
        return { eq: async (c: string, v: any) => { const i = rows().findIndex((x: any) => x[c] === v); if (i >= 0) rows().splice(i, 1); return { error: null }; } };
      },
    };
    return builder;
  };
  return { supabase: { from: q } };
});
vi.mock('@/lib/logger', () => ({ log: { info: () => {}, warn: () => {}, error: () => {}, request: () => {} } }));
vi.mock('@/lib/http', async () => ({ withApi: (h: any) => h, errorResponse: () => new Response('e', { status: 500 }), badRequest: (m: string) => new Response(m, { status: 400 }) }));
vi.mock('@/lib/session', () => ({
  signSession: async () => 'signed-token',
  SESSION_COOKIE: 'lr_session',
  SESSION_MAX_AGE: 3600,
}));
// Opaque on purpose. A mock like `hashed:${p}` embeds the password by
// construction, so the "not stored in the clear" assertion below would fail
// against correct code and pass against nothing — it would be testing the fake.
vi.mock('@/lib/password', () => ({
  hashPassword: (p: string) => `sha256$${[...p].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`,
  verifyPassword: () => true,
}));

let ip = 0;
async function post(body: any, addr?: string) {
  const { POST } = await import('@/app/api/auth/signup/route');
  return POST(new Request('https://app.leadrail.xyz/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': addr ?? `10.1.0.${++ip % 250}` },
    body: JSON.stringify(body),
  }) as any);
}

const VALID = { email: 'new@company.com', password: 'a-long-enough-password', company: 'Acme' };

beforeEach(async () => {
  db.members = []; db.accounts = []; db.failMemberInsert = false;
  vi.resetModules();
  const { __resetRateLimits } = await import('@/lib/rate-limit');
  __resetRateLimits();
});

describe('closed by default', () => {
  it('refuses when SIGNUPS_OPEN is not set, and creates nothing', async () => {
    delete process.env.SIGNUPS_OPEN;
    const res = await post(VALID);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('signups_closed');
    expect(db.accounts).toHaveLength(0);
  });

  it('is not opened by a truthy-looking value other than "1"', async () => {
    // 'true'/'yes' must NOT open registration — a config typo should fail
    // closed, never open.
    for (const v of ['true', 'yes', '0', '']) {
      process.env.SIGNUPS_OPEN = v;
      vi.resetModules();
      expect((await post(VALID)).status).toBe(403);
    }
    delete process.env.SIGNUPS_OPEN;
  });
});

describe('when open', () => {
  beforeEach(() => { process.env.SIGNUPS_OPEN = '1'; vi.resetModules(); });

  it('creates the account and the owner, and signs the caller in', async () => {
    const res = await post(VALID);
    expect(res.status).toBe(200);
    expect(db.accounts).toHaveLength(1);
    expect(db.members[0].role).toBe('owner');
    expect(res.headers.get('set-cookie') || '').toContain('lr_session');
  });

  it('never stores the password in the clear', async () => {
    await post(VALID);
    expect(db.members[0].password_hash).toBeTruthy();
    expect(db.members[0].password_hash).not.toBe(VALID.password);
    // Nothing anywhere on the row may echo the raw secret.
    expect(JSON.stringify(db.members[0])).not.toContain(VALID.password);
  });

  it('sets an httpOnly, secure session cookie', async () => {
    const c = (await post(VALID)).headers.get('set-cookie') || '';
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Secure/i);
  });

  it.each([
    ['a bad email', { ...VALID, email: 'nope' }],
    ['a short password', { ...VALID, password: 'short' }],
  ])('rejects %s without creating anything', async (_l, body) => {
    expect((await post(body)).status).toBe(400);
    expect(db.accounts).toHaveLength(0);
  });

  it('does not reveal whether an email already exists', async () => {
    await post(VALID);
    const res = await post({ ...VALID, password: 'another-long-password' });
    expect(res.status).toBe(409);
    const msg = (await res.json()).error as string;
    // "That email is taken" turns this endpoint into a membership oracle —
    // anyone can test an address list against it.
    expect(msg.toLowerCase()).not.toContain('already');
    expect(msg.toLowerCase()).not.toContain('exists');
    expect(msg).not.toContain(VALID.email);
    expect(db.accounts).toHaveLength(1);
  });

  it('leaves no orphan account when the owner cannot be created', async () => {
    // An account with no member is unreachable forever — nobody can sign in to
    // it and nothing will ever clean it up.
    db.failMemberInsert = true;
    const res = await post(VALID);
    expect(res.status).toBe(500);
    expect(db.accounts).toHaveLength(0);
  });

  it('rate-limits repeated attempts from one address', async () => {
    for (let i = 0; i < 3; i++) await post({ ...VALID, email: `u${i}@x.com` }, '198.51.100.1');
    const res = await post({ ...VALID, email: 'u9@x.com' }, '198.51.100.1');
    expect(res.status).toBe(429);
  });
});

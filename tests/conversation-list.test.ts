// The list endpoint existed, was correct, and was called by nothing. That is
// why twenty-eight conversations sat intact and unreachable while it looked
// like refreshing had deleted them — the only route back to a chat was a
// four-slot localStorage tab or a saved ?c= URL.
//
// These pin the paging contract the history panel is built against, because
// retrofitting paging after a UI assumes a flat list is the expensive order.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: any[] = [];
let lastFilters: Record<string, any> = {};

vi.mock('@/lib/db', () => ({
  supabase: {
    from() {
      const q: any = {
        _f: [] as ((r: any) => boolean)[], _limit: Infinity, _desc: true,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
        // migration 069's soft-delete exclusion filter. Seeded rows here never
        // carry deleted_at, so `IS NULL` (v === null) always matches — this
        // suite is about paging/search, not deletion (see
        // tests/conversation-deletion.test.ts for that).
        is(c: string, v: any) {
          q._f.push((r: any) => (v === null ? (r[c] === null || r[c] === undefined) : r[c] === v));
          return q;
        },
        lt(c: string, v: any) { lastFilters.lt = { c, v }; q._f.push((r: any) => r[c] < v); return q; },
        ilike(c: string, v: any) {
          lastFilters.ilike = { c, v };
          const needle = String(v).replace(/%/g, '').toLowerCase();
          q._f.push((r: any) => String(r[c] ?? '').toLowerCase().includes(needle));
          return q;
        },
        order(_c: string, o?: any) { q._desc = o?.ascending === false; return q; },
        limit(n: number) { q._limit = n; lastFilters.limit = n; return q; },
        then(resolve: any) {
          let out = rows.filter((r) => q._f.every((f: any) => f(r)));
          out = out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
          return resolve({ data: out.slice(0, q._limit), error: null });
        },
      };
      return q;
    },
  },
  dbReady: () => true,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() } }));

const ACC = 'acct-1';

function seed(n: number) {
  rows = Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    title: `Chat ${i}`,
    // Descending time: c0 newest.
    updated_at: new Date(Date.UTC(2026, 7, 27, 12, 0, 0) - i * 60_000).toISOString(),
    token_estimate: 100 + i,
    account_id: ACC,
  }));
  lastFilters = {};
}

async function list(limit?: number, cursor?: string | null, search?: string | null) {
  const { listConversationsForAccount } = await import('@/lib/agent/memory');
  return listConversationsForAccount(ACC, limit as any, cursor, search);
}

describe('paging', () => {
  beforeEach(() => { vi.resetModules(); });

  it('returns a page plus a cursor when there is more', async () => {
    seed(28);
    const page = await list(10);
    expect(page.conversations).toHaveLength(10);
    expect(page.nextCursor).toBe(page.conversations[9].updated_at);
  });

  it('returns a null cursor on the last page, so the UI knows to stop', async () => {
    seed(8);
    const page = await list(10);
    expect(page.conversations).toHaveLength(8);
    expect(page.nextCursor).toBeNull();
  });

  it('walks the whole set without repeating or skipping a row', async () => {
    // The property that matters. An OFFSET cannot promise this: `updated_at`
    // changes as chats are used, so replying to an old one mid-walk shifts
    // every later page.
    seed(28);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: any = await list(10, cursor);
      seen.push(...page.conversations.map((c: any) => c.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(28);
    expect(new Set(seen).size).toBe(28);
  });

  it('fetches one extra row to detect the page end, rather than counting', async () => {
    seed(28);
    await list(10);
    // n+1: cheaper than a COUNT, and a COUNT would be stale the moment a turn
    // lands anyway.
    expect(lastFilters.limit).toBe(11);
  });

  it('pages on updated_at, not an offset', async () => {
    seed(28);
    const first = await list(10);
    await list(10, first.nextCursor);
    expect(lastFilters.lt).toMatchObject({ c: 'updated_at' });
  });

  it('clamps an absurd limit instead of trusting it', async () => {
    seed(28);
    await list(100000);
    expect(lastFilters.limit).toBe(101);   // 100 max, +1 probe
  });
});

describe('search', () => {
  beforeEach(() => { vi.resetModules(); });

  it('filters by title', async () => {
    seed(28);
    const page = await list(30, null, 'Chat 1');
    expect(page.conversations.length).toBeGreaterThan(0);
    expect(page.conversations.every((c) => (c.title || '').includes('Chat 1'))).toBe(true);
  });

  it('ignores a blank query rather than filtering on empty', async () => {
    seed(5);
    const page = await list(30, null, '   ');
    expect(page.conversations).toHaveLength(5);
    expect(lastFilters.ilike).toBeUndefined();
  });
});

describe('failure', () => {
  beforeEach(() => { vi.resetModules(); });

  it('returns an empty page rather than throwing', async () => {
    vi.doMock('@/lib/db', () => ({
      supabase: { from() { throw new Error('down'); } }, dbReady: () => true,
    }));
    const { listConversationsForAccount } = await import('@/lib/agent/memory');
    await expect(listConversationsForAccount(ACC, 10)).resolves.toEqual({
      conversations: [], nextCursor: null,
    });
  });
});

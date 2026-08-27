// DELETE /api/agent/conversations/:id must not become an existence oracle —
// exactly the property the route's own GET handler already documents and
// relies on (loadTranscript / loadConversation never distinguish "not yours"
// from "unknown"). This proves the DELETE route holds the same property, and
// that deleting your own conversation actually works end to end through the
// route, not just at the memory.ts layer.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

interface Row { [k: string]: any }
let rows: Row[] = [];

/** Same minimal fake as tests/conversation-deletion.test.ts, trimmed to what
 *  the DELETE route's path (deleteConversation) actually issues. */
function makeClient() {
  return {
    from() {
      const q: any = {
        _f: [] as ((r: Row) => boolean)[],
        _mode: 'select' as 'select' | 'update',
        _patch: null as Row | null,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: Row) => r[c] === v); return q; },
        is(c: string, v: any) {
          q._f.push((r: Row) => (v === null ? (r[c] === null || r[c] === undefined) : r[c] === v));
          return q;
        },
        update(p: Row) { q._mode = 'update'; q._patch = p; return q; },
        _exec() {
          let matched = rows.filter((r) => q._f.every((f: any) => f(r)));
          if (q._mode === 'update') for (const r of matched) Object.assign(r, q._patch);
          return matched;
        },
        then(resolve: any) { return Promise.resolve({ data: q._exec(), error: null }).then(resolve); },
      };
      return q;
    },
  };
}

const ACC = 'acct-1';

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
  requestStore: { run: (_store: any, fn: any) => fn() },
  enrichContext: vi.fn(),
  currentContext: () => undefined,
}));
vi.mock('@/lib/session', () => ({
  verifySession: vi.fn(async () => ({ email: 'op@example.com', accountId: ACC, role: 'owner', exp: 0 })),
  SESSION_COOKIE: 'ma_session',
}));
vi.mock('@/lib/approvals/store', () => ({ pendingApprovalForConversation: vi.fn(async () => null) }));

beforeEach(() => {
  vi.resetModules();
  rows = [
    { id: 'conv-mine', account_id: ACC, deleted_at: null },
    { id: 'conv-foreign', account_id: 'acct-2', deleted_at: null },
  ];
});

async function callDelete(id: string) {
  const { DELETE } = await import('@/app/api/agent/conversations/[id]/route');
  const req = new NextRequest(`http://localhost/api/agent/conversations/${id}`, { method: 'DELETE' });
  const res = await DELETE(req, { params: { id } });
  return { status: res.status, body: await res.json() };
}

describe('DELETE /api/agent/conversations/[id]', () => {
  it('soft-deletes a conversation the session\'s account owns', async () => {
    const { status, body } = await callDelete('conv-mine');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, deleted: true });
    expect(rows.find((r) => r.id === 'conv-mine')!.deleted_at).toBeTruthy();
  });

  it('an unknown id and another account\'s id get the identical response', async () => {
    const unknown = await callDelete('conv-does-not-exist');
    const foreign = await callDelete('conv-foreign');
    expect(unknown).toEqual(foreign);
    expect(unknown).toEqual({ status: 200, body: { ok: true, deleted: false } });
    // Provably untouched, not just "reported false".
    expect(rows.find((r) => r.id === 'conv-foreign')!.deleted_at).toBeNull();
  });
});

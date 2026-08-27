// Defect 2: GET /api/agent/conversations/:id must surface whether a turn is
// still running server-side (migration 072), so the client's mount-time
// rehydration effect can tell "still working on it" apart from "that's all
// there is". Drives the real route against a fake supabase client, same
// pattern as tests/conversation-deletion-route.test.ts, so this can only pass
// if the route actually wires isConversationRunning into its response.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

interface Row { [k: string]: any }
let rows: Row[] = [];

function makeClient() {
  return {
    from() {
      const q: any = {
        _f: [] as ((r: Row) => boolean)[],
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: Row) => r[c] === v); return q; },
        is(c: string, v: any) {
          q._f.push((r: Row) => (v === null ? (r[c] === null || r[c] === undefined) : r[c] === v));
          return q;
        },
        maybeSingle: async () => {
          const matched = rows.filter((r) => q._f.every((f: any) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) {
          const matched = rows.filter((r) => q._f.every((f: any) => f(r)));
          return Promise.resolve({ data: matched, error: null }).then(resolve);
        },
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

beforeEach(() => { vi.resetModules(); rows = []; });

async function callGet(id: string) {
  const { GET } = await import('@/app/api/agent/conversations/[id]/route');
  const req = new NextRequest(`http://localhost/api/agent/conversations/${id}`);
  const res = await GET(req, { params: { id } });
  return { status: res.status, body: await res.json() };
}

describe('GET /api/agent/conversations/[id] — running flag', () => {
  it('reports running: true for a conversation with a fresh running_since', async () => {
    rows = [{ id: 'conv-1', account_id: ACC, deleted_at: null, transcript: [], running_since: new Date().toISOString() }];
    const { status, body } = await callGet('conv-1');
    expect(status).toBe(200);
    expect(body.running).toBe(true);
  });

  it('reports running: false when no turn is in progress', async () => {
    rows = [{ id: 'conv-1', account_id: ACC, deleted_at: null, transcript: [], running_since: null }];
    const { body } = await callGet('conv-1');
    expect(body.running).toBe(false);
  });

  it('reports running: false for a stale running_since (a process that died mid-turn)', async () => {
    const staleSince = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    rows = [{ id: 'conv-1', account_id: ACC, deleted_at: null, transcript: [], running_since: staleSince }];
    const { body } = await callGet('conv-1');
    expect(body.running).toBe(false);
  });

  it('never reports another account\'s conversation as running — scoped in the query', async () => {
    rows = [{ id: 'conv-1', account_id: 'other-account', deleted_at: null, transcript: [], running_since: new Date().toISOString() }];
    const { body } = await callGet('conv-1');
    expect(body.running).toBe(false);
  });
});

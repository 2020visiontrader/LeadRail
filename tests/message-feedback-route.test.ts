// POST/GET /api/agent/feedback — migration 080_message_feedback.sql's reader
// and writer. Proves, end to end through the route (not just at the store
// layer): a vote is recorded; a changed vote UPDATES the same row rather than
// appending a second one; and a conversation/message belonging to another
// account is refused exactly like this repo's other conversation-scoped
// routes refuse cross-tenant access (see conversation-deletion-route.test.ts
// for the same discipline applied to DELETE).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

interface Row { [k: string]: any }
let conversations: Row[] = [];
let feedback: Row[] = [];

/** Minimal fake covering exactly what this route's path issues: a `select`
 *  read on agent_conversations (loadConversation), and a `select` / `upsert`
 *  on message_feedback (listFeedbackForConversation / recordMessageFeedback).
 *  Modeled after tests/conversation-deletion-route.test.ts's fake client. */
function makeClient() {
  function selectable(table: string) {
    const q: any = {
      _f: [] as ((r: Row) => boolean)[],
      eq(c: string, v: any) { q._f.push((r: Row) => r[c] === v); return q; },
      is(c: string, v: any) {
        q._f.push((r: Row) => (v === null ? (r[c] === null || r[c] === undefined) : r[c] === v));
        return q;
      },
      not(c: string, _op: string, v: any) { q._f.push((r: Row) => r[c] !== v); return q; },
      order() { return q; },
      limit() { return q; },
      select() { return q; },
      _rows() { return table === 'agent_conversations' ? conversations : feedback; },
      _exec() { return q._rows().filter((r: Row) => q._f.every((f: any) => f(r))); },
      maybeSingle() { const m = q._exec(); return Promise.resolve({ data: m[0] ?? null, error: null }); },
      then(resolve: any) { return Promise.resolve({ data: q._exec(), error: null }).then(resolve); },
    };
    return q;
  }
  return {
    from(table: string) {
      return {
        select: () => selectable(table),
        upsert(rows: Row[], _opts: any) {
          const row = rows[0];
          const idx = feedback.findIndex((r) => r.account_id === row.account_id && r.message_id === row.message_id);
          if (idx === -1) {
            const created = { id: `fb-${feedback.length + 1}`, ...row };
            feedback.push(created);
            return { select: () => ({ maybeSingle: async () => ({ data: created, error: null }) }) };
          }
          feedback[idx] = { ...feedback[idx], ...row };
          return { select: () => ({ maybeSingle: async () => ({ data: feedback[idx], error: null }) }) };
        },
      };
    },
  };
}

const ACC = 'acct-1';
const OTHER = 'acct-2';

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

beforeEach(() => {
  vi.resetModules();
  conversations = [
    { id: 'conv-mine', account_id: ACC, deleted_at: null, transcript: [{ role: 'user', content: 'hi', id: 'msg-1' }, { role: 'assistant', content: 'hello', id: 'msg-2' }] },
    { id: 'conv-foreign', account_id: OTHER, deleted_at: null, transcript: [{ role: 'assistant', content: 'x', id: 'msg-3' }] },
  ];
  feedback = [];
});

async function callPost(body: any) {
  const { POST } = await import('@/app/api/agent/feedback/route');
  const req = new NextRequest('http://localhost/api/agent/feedback', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  });
  const res = await POST(req);
  return { status: res.status, body: await res.json() };
}
async function callGet(conversationId: string) {
  const { GET } = await import('@/app/api/agent/feedback/route');
  const req = new NextRequest(`http://localhost/api/agent/feedback?conversationId=${conversationId}`);
  const res = await GET(req);
  return { status: res.status, body: await res.json() };
}

describe('POST /api/agent/feedback', () => {
  it('records a vote on a message in a conversation this account owns', async () => {
    const { status, body } = await callPost({ conversationId: 'conv-mine', messageId: 'msg-2', up: true });
    expect(status).toBe(200);
    expect(body.feedback.up).toBe(true);
    expect(feedback).toHaveLength(1);
  });

  it('REVERT-CHECK TARGET: changing a vote UPDATES the same row, never appends a second one', async () => {
    await callPost({ conversationId: 'conv-mine', messageId: 'msg-2', up: true });
    const { status, body } = await callPost({ conversationId: 'conv-mine', messageId: 'msg-2', up: false });
    expect(status).toBe(200);
    expect(body.feedback.up).toBe(false);
    expect(feedback).toHaveLength(1); // <- the assertion the constraint/upsert path exists to guarantee
  });

  it('refuses a write against a conversation belonging to another account', async () => {
    const { status, body } = await callPost({ conversationId: 'conv-foreign', messageId: 'msg-3', up: true });
    expect(status).toBe(400);
    expect(feedback).toHaveLength(0);
    expect(body.error).toBeTruthy();
  });

  it('refuses a write for a messageId that is not actually in the named conversation', async () => {
    const { status } = await callPost({ conversationId: 'conv-mine', messageId: 'not-a-real-message', up: true });
    expect(status).toBe(400);
    expect(feedback).toHaveLength(0);
  });
});

describe('GET /api/agent/feedback', () => {
  it('returns this account\'s votes for a conversation it owns', async () => {
    await callPost({ conversationId: 'conv-mine', messageId: 'msg-2', up: true });
    const { status, body } = await callGet('conv-mine');
    expect(status).toBe(200);
    expect(body.feedback['msg-2'].up).toBe(true);
  });

  it('reads as empty for a conversation belonging to another account — no existence oracle', async () => {
    const { status, body } = await callGet('conv-foreign');
    expect(status).toBe(200);
    expect(body.feedback).toEqual({});
  });
});

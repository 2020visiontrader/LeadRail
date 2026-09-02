// POST /api/agent/conversations/[id]/rerun — the RETRY SAFETY property from
// the message-actions Packet.
//
// THE DEFECT THIS GUARDS AGAINST. Re-running a turn re-runs its tools. If the
// discarded turn called sendEmail (gated `external_send`) under a STANDING
// GRANT (lib/approvals/grants.ts, migration 062 — "approve sendEmail for this
// whole conversation"), that grant is still live and still scoped to this
// conversation_id after a plain truncate. A rerun would walk back into
// runTool, find the same live grant, and silently resend the email with no
// human back in the loop.
//
// lib/agent/loop.ts (where runTool actually consumes a grant) is off-limits
// for this Packet — a concurrent session owns it — so this proves the
// property one layer up, at the one place available to close it: the /rerun
// route must revoke every live grant for the conversation BEFORE a rerun can
// proceed. A revoked grant (revoked_at set) is what makes the NEXT tool call
// re-raise an ordinary approval card instead of auto-executing — this test
// asserts that revocation actually happens, which is the durable, checkable
// half of that guarantee from outside loop.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

interface Row { [k: string]: any }
let conversations: Row[] = [];
let grants: Row[] = [];

function table(name: string) {
  return name === 'agent_conversations' ? conversations : grants;
}

function makeClient() {
  return {
    from(name: string) {
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
        gt(c: string, v: any) { q._f.push((r: Row) => r[c] > v); return q; },
        update(p: Row) { q._mode = 'update'; q._patch = p; return q; },
        _exec() {
          let matched = table(name).filter((r: Row) => q._f.every((f: any) => f(r)));
          if (q._mode === 'update') for (const r of matched) Object.assign(r, q._patch);
          return matched;
        },
        maybeSingle() { const m = q._exec(); return Promise.resolve({ data: m[0] ?? null, error: null }); },
        then(resolve: any) { return Promise.resolve({ data: q._exec(), error: null }).then(resolve); },
      };
      return q;
    },
  };
}

const ACC = 'acct-1';
const CONV = 'conv-1';

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

const FAR_FUTURE = new Date(Date.now() + 3600_000).toISOString();

beforeEach(() => {
  vi.resetModules();
  conversations = [{
    id: CONV, account_id: ACC, deleted_at: null, token_estimate: 40, message_count: 4,
    transcript: [
      { role: 'user', content: 'send the invoice email', id: 'u1' },
      { role: 'assistant', content: '{"action":"tool","tool":"sendEmail"}', id: 'a1' },
      { role: 'user', content: 'ok now do it again', id: 'u2' },
      { role: 'assistant', content: '{"action":"final","message":"sent"}', id: 'a2' },
    ],
  }];
  grants = [{
    id: 'grant-1', account_id: ACC, conversation_id: CONV, tool: 'sendEmail',
    uses_remaining: 5, expires_at: FAR_FUTURE, revoked_at: null,
  }];
});

async function callRerun(id: string, messageId: string) {
  const { POST } = await import('@/app/api/agent/conversations/[id]/rerun/route');
  const req = new NextRequest(`http://localhost/api/agent/conversations/${id}/rerun`, {
    method: 'POST', body: JSON.stringify({ messageId }), headers: { 'Content-Type': 'application/json' },
  });
  const res = await POST(req, { params: { id } });
  return { status: res.status, body: await res.json() };
}

describe('POST /api/agent/conversations/[id]/rerun — retry safety', () => {
  it('REVERT-CHECK TARGET: revokes every live standing grant for the conversation before truncating', async () => {
    const { status, body } = await callRerun(CONV, 'u2');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // The grant that would otherwise auto-approve a resent sendEmail call is
    // now dead — the next tool call in the rerun turn MUST re-raise a normal
    // approval card, because consumeGrant (lib/approvals/grants.ts) only ever
    // matches revoked_at IS NULL.
    expect(grants[0].revoked_at).toBeTruthy();
  });

  it('truncates the transcript to drop the named message and everything after it', async () => {
    await callRerun(CONV, 'u2');
    const saved = conversations.find((c) => c.id === CONV)!;
    expect(saved.transcript.map((m: any) => m.id)).toEqual(['u1', 'a1']);
  });

  it('revokes the grant even when nothing is ultimately truncated (unknown messageId) — safety before the truncate attempt, not after', async () => {
    const { status } = await callRerun(CONV, 'does-not-exist');
    expect(status).toBe(400); // truncate itself is refused
    expect(grants[0].revoked_at).toBeTruthy(); // but the grant was already revoked first
  });

  it('does not touch a grant belonging to a different conversation', async () => {
    grants.push({ id: 'grant-2', account_id: ACC, conversation_id: 'conv-other', tool: 'sendEmail', uses_remaining: 5, expires_at: FAR_FUTURE, revoked_at: null });
    await callRerun(CONV, 'u2');
    expect(grants.find((g) => g.id === 'grant-2')!.revoked_at).toBeNull();
  });
});

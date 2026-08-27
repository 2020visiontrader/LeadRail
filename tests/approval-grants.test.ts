// A standing approval is the one permission nobody watches as it is used, so
// its bounds are the whole safety story. These assert the bounds, not the
// happy path.
//
// The motivating data: 29 enrichLead approvals in this account, 3 lapsed
// unanswered. enrichLead is per-lead and carries the spend gate, so "pull
// fifty" became fifty cards for a decision made once at batch scale.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isGrantable, GRANTABLE_GATES, MAX_GRANT_USES } from '@/lib/approvals/grants';

let grants: any[] = [];
let rpcCalls: any[] = [];
let idSeq = 0;

/** Fake client whose RPC mirrors consume_approval_grant's real semantics:
 *  find the oldest live grant, decrement, return remaining — or nothing. */
function makeClient() {
  return {
    rpc: async (fn: string, params: any) => {
      rpcCalls.push({ fn, params });
      if (fn !== 'consume_approval_grant') return { data: null, error: null };
      const now = Date.now();
      const live = grants
        .filter((g) => g.account_id === params.p_account
          && g.conversation_id === params.p_conversation
          && g.tool === params.p_tool
          && g.revoked_at == null
          && new Date(g.expires_at).getTime() > now
          && g.uses_remaining > 0)
        .sort((a, b) => a.created_at - b.created_at);
      if (!live.length) return { data: [], error: null };
      live[0].uses_remaining -= 1;
      return { data: [{ grant_id: live[0].id, uses_left: live[0].uses_remaining }], error: null };
    },
    from(_t: string) {
      const q: any = {
        _f: [] as ((r: any) => boolean)[], _mode: 'select', _patch: null as any,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
        is(c: string, v: any) { q._f.push((r: any) => (v === null ? r[c] == null : r[c] === v)); return q; },
        gt(c: string, v: any) {
          q._f.push((r: any) => (c === 'expires_at' ? new Date(r[c]).getTime() > new Date(v).getTime() : r[c] > v));
          return q;
        },
        order() { return q; },
        insert(rows: any[]) {
          const created = rows.map((r) => ({ id: `g-${++idSeq}`, revoked_at: null, created_at: Date.now() + idSeq, ...r }));
          grants.push(...created);
          return { select: () => ({ single: async () => ({ data: created[0], error: null }) }) };
        },
        update(p: any) { q._mode = 'update'; q._patch = p; return q; },
        then(resolve: any) {
          const rows = grants.filter((r) => q._f.every((f: any) => f(r)));
          if (q._mode === 'update') {
            for (const r of rows) Object.assign(r, q._patch);
            return resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
          }
          return resolve({ data: rows, error: null });
        },
      };
      return q;
    },
  };
}

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() } }));

const ACC = 'acct-1';
const CONV = 'conv-1';

async function mod() { return import('@/lib/approvals/grants'); }

describe('which actions may ever be made standing', () => {
  it('allows the repetitive gates — spend and external send', () => {
    expect(isGrantable('spend')).toBe(true);
    expect(isGrantable('external_send')).toBe(true);
  });

  it('REFUSES destructive and standing_rule', () => {
    // Nobody legitimately deletes fifty times in a row, so a grant buys no
    // ergonomics there while removing the last checkpoint before something
    // irreversible. standing_rule creates rules that run unattended — granting
    // blanket permission to create those compounds.
    expect(isGrantable('destructive')).toBe(false);
    expect(isGrantable('standing_rule')).toBe(false);
  });

  it('refuses a missing gate rather than defaulting to permitted', () => {
    expect(isGrantable(undefined)).toBe(false);
  });

  it('keeps the grantable set small and explicit', () => {
    expect(GRANTABLE_GATES).toEqual(['spend', 'external_send']);
  });
});

describe('a grant is bounded', () => {
  beforeEach(() => { grants = []; rpcCalls = []; idSeq = 0; });

  it('is capped however many uses were asked for', async () => {
    const { createGrant } = await mod();
    const { grant, clampedTo } = await createGrant({
      accountId: ACC, conversationId: CONV, tool: 'enrichLead', uses: 100000,
    });
    expect(grant!.usesRemaining).toBe(MAX_GRANT_USES);
    // Reported, so the UI can say what was actually given rather than implying
    // the request was honoured in full.
    expect(clampedTo).toBe(MAX_GRANT_USES);
  });

  it('refuses a zero or negative grant instead of creating an unusable one', async () => {
    const { createGrant } = await mod();
    expect((await createGrant({ accountId: ACC, conversationId: CONV, tool: 'x', uses: 0 })).grant).toBeNull();
    expect((await createGrant({ accountId: ACC, conversationId: CONV, tool: 'x', uses: -5 })).grant).toBeNull();
  });

  it('runs out — the 51st call on a grant of 50 asks again', async () => {
    const { createGrant, consumeGrant } = await mod();
    await createGrant({ accountId: ACC, conversationId: CONV, tool: 'enrichLead', uses: 50 });
    for (let i = 0; i < 50; i++) {
      expect(await consumeGrant(ACC, CONV, 'enrichLead')).not.toBeNull();
    }
    expect(await consumeGrant(ACC, CONV, 'enrichLead')).toBeNull();
  });

  it('reports how many uses are left, so the last one is not a surprise', async () => {
    const { createGrant, consumeGrant } = await mod();
    await createGrant({ accountId: ACC, conversationId: CONV, tool: 'enrichLead', uses: 3 });
    expect((await consumeGrant(ACC, CONV, 'enrichLead'))!.usesLeft).toBe(2);
    expect((await consumeGrant(ACC, CONV, 'enrichLead'))!.usesLeft).toBe(1);
    expect((await consumeGrant(ACC, CONV, 'enrichLead'))!.usesLeft).toBe(0);
  });
});

describe('a grant is scoped', () => {
  beforeEach(() => { grants = []; rpcCalls = []; idSeq = 0; });

  it('covers ONE tool — approving enrichLead says nothing about sendEmail', async () => {
    const { createGrant, consumeGrant } = await mod();
    await createGrant({ accountId: ACC, conversationId: CONV, tool: 'enrichLead', uses: 10 });
    expect(await consumeGrant(ACC, CONV, 'enrichLead')).not.toBeNull();
    expect(await consumeGrant(ACC, CONV, 'sendEmail')).toBeNull();
  });

  it('does NOT carry into the next conversation — the next session asks again', async () => {
    const { createGrant, consumeGrant } = await mod();
    await createGrant({ accountId: ACC, conversationId: CONV, tool: 'enrichLead', uses: 10 });
    expect(await consumeGrant(ACC, 'conv-2', 'enrichLead')).toBeNull();
  });

  it('never crosses accounts', async () => {
    const { createGrant, consumeGrant } = await mod();
    await createGrant({ accountId: ACC, conversationId: CONV, tool: 'enrichLead', uses: 10 });
    expect(await consumeGrant('other-account', CONV, 'enrichLead')).toBeNull();
  });

  it('expires', async () => {
    const { createGrant, consumeGrant } = await mod();
    await createGrant({ accountId: ACC, conversationId: CONV, tool: 'enrichLead', uses: 10, ttlMs: -1000 });
    expect(await consumeGrant(ACC, CONV, 'enrichLead')).toBeNull();
  });
});

describe('withdrawal beats the grant, immediately', () => {
  beforeEach(() => { grants = []; rpcCalls = []; idSeq = 0; });

  it('stops mid-batch when revoked', async () => {
    const { createGrant, consumeGrant, revokeGrant } = await mod();
    const { grant } = await createGrant({ accountId: ACC, conversationId: CONV, tool: 'enrichLead', uses: 50 });
    expect(await consumeGrant(ACC, CONV, 'enrichLead')).not.toBeNull();
    expect(await revokeGrant(ACC, grant!.id)).toBe(true);
    // 48 uses were still on the clock and are now worth nothing — which is the
    // point of a "stop" that a user can reach for mid-run.
    expect(await consumeGrant(ACC, CONV, 'enrichLead')).toBeNull();
  });

  it('cannot be revoked by another account', async () => {
    const { createGrant, revokeGrant } = await mod();
    const { grant } = await createGrant({ accountId: ACC, conversationId: CONV, tool: 'enrichLead', uses: 5 });
    expect(await revokeGrant('other-account', grant!.id)).toBe(false);
  });

  it('revokes everything on the account in one move', async () => {
    const { createGrant, revokeAllForAccount, consumeGrant } = await mod();
    await createGrant({ accountId: ACC, conversationId: CONV, tool: 'enrichLead', uses: 5 });
    await createGrant({ accountId: ACC, conversationId: 'conv-2', tool: 'sendEmail', uses: 5 });
    expect(await revokeAllForAccount(ACC)).toBe(2);
    expect(await consumeGrant(ACC, CONV, 'enrichLead')).toBeNull();
    expect(await consumeGrant(ACC, 'conv-2', 'sendEmail')).toBeNull();
  });
});

describe('fails closed', () => {
  beforeEach(() => { grants = []; rpcCalls = []; idSeq = 0; });

  it('returns null with no conversation id, without even asking the database', async () => {
    const { consumeGrant } = await mod();
    expect(await consumeGrant(ACC, null, 'enrichLead')).toBeNull();
    expect(await consumeGrant(ACC, undefined, 'enrichLead')).toBeNull();
    expect(rpcCalls).toHaveLength(0);
  });

  it('returns null when the database errors — never assumes permission', async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({
      supabase: { rpc: async () => ({ data: null, error: { message: 'boom' } }) },
      dbReady: () => true,
    }));
    const { consumeGrant } = await import('@/lib/approvals/grants');
    // The failure mode in the other direction is spending money nobody
    // approved, so an unreachable database must mean "ask", never "proceed".
    expect(await consumeGrant(ACC, CONV, 'enrichLead')).toBeNull();
  });
});

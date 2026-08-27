// Migration 059 designed a write guard so "a shrinking write matches no rows
// instead of destroying one". The column has been maintained on every save
// since and used as a condition NOWHERE — the protection existed only in a
// comment. This is that guard, attached.
//
// BOTH DIRECTIONS ARE TESTED, because this fix inverts if you get it wrong:
//
//   - a catastrophic shrink must be REFUSED  (the bug it exists to stop)
//   - a capTranscript shrink must be ALLOWED (the bug it would introduce)
//
// And the refusal must never fork. A rejected write and a stale id both come
// back as no-error-and-no-row, so a naive guard would treat a rejection as a
// missing row, INSERT, and split the conversation in two — producing the exact
// "my chat disappeared" symptom it was meant to prevent.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Row { [k: string]: any }
let rows: Row[] = [];
let inserted: Row[] = [];
let idSeq = 0;

/** PostgREST-shaped fake with the one filter that matters: `.lte` actually
 *  filters, so a refused update really matches zero rows here. */
function makeClient() {
  return {
    from() {
      const q: any = {
        _f: [] as ((r: Row) => boolean)[], _mode: 'select', _patch: null as Row | null,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: Row) => r[c] === v); return q; },
        lte(c: string, v: any) { q._f.push((r: Row) => (r[c] ?? 0) <= v); return q; },
        // migration 069's soft-delete exclusion filter. Seeded rows here never
        // carry deleted_at, so `IS NULL` (v === null) always matches them —
        // this suite is about the shrink guard, not deletion.
        is(c: string, v: any) {
          q._f.push((r: Row) => (v === null ? (r[c] === null || r[c] === undefined) : r[c] === v));
          return q;
        },
        insert(payload: Row) {
          const created = { id: `conv-${++idSeq}`, ...payload };
          rows.push(created); inserted.push(created);
          return { select: () => ({ maybeSingle: async () => ({ data: { id: created.id }, error: null }) }) };
        },
        update(p: Row) { q._mode = 'update'; q._patch = p; return q; },
        maybeSingle: async () => {
          const matched = rows.filter((r) => q._f.every((f: any) => f(r)));
          if (q._mode === 'update') {
            for (const r of matched) Object.assign(r, q._patch);
            return { data: matched[0] ? { id: matched[0].id } : null, error: null };
          }
          return { data: matched[0] ?? null, error: null };
        },
      };
      return q;
    },
  };
}

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
const logError = vi.fn();
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: (...a: any[]) => logError(...a), request: vi.fn() },
}));

const ACC = 'acct-1';
const CONV = 'conv-existing';

/** A transcript of `n` messages, each `chars` long. estimateTokens is
 *  length/4, so this gives predictable token counts. */
function transcript(n: number, chars = 400) {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
    content: 'x'.repeat(chars),
  }));
}
const tokensFor = (n: number, chars = 400) => Math.ceil((n * chars) / 4);

function seed(messages: number, chars = 400) {
  rows = [{
    id: CONV, account_id: ACC,
    transcript: transcript(messages, chars),
    message_count: messages,
    token_estimate: tokensFor(messages, chars),
  }];
  inserted = [];
}

/** `id` is passed through EXACTLY as given. A default parameter would turn an
 *  explicit `undefined` back into CONV — which silently made the "no id at all"
 *  case test a shrink instead, and pass for the wrong reason. */
async function save(messages: number, chars = 400, ...idArg: [string | undefined] | []) {
  const { saveConversation } = await import('@/lib/agent/memory');
  const id = idArg.length ? idArg[0] : CONV;
  return saveConversation({ id, accountId: ACC, transcript: transcript(messages, chars) });
}

describe('a catastrophic shrink is refused', () => {
  beforeEach(() => { vi.resetModules(); logError.mockClear(); idSeq = 0; });

  it('refuses to replace a long transcript with a stub', async () => {
    // The failure migration 059 was written for: a 42-message conversation
    // overwritten by a 1-message one.
    seed(42);
    expect(await save(1)).toBeNull();
    expect(rows[0].message_count).toBe(42);   // untouched
  });

  it('does NOT fork — the whole point of disambiguating zero rows', async () => {
    // A rejection and a stale id both return no-error-and-no-row. Inserting
    // here would split the conversation and hand the client the new id.
    seed(42);
    await save(1);
    expect(inserted).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });

  it('says loudly what it refused, with both sides of the comparison', async () => {
    seed(42);
    await save(1);
    const call = logError.mock.calls.find((c) => String(c[0]).includes('refused a shrinking write'));
    expect(call).toBeTruthy();
    expect(call![2]).toMatchObject({ storedMessages: 42, writingMessages: 1 });
  });
});

describe('a legitimate shrink is ALLOWED — the inversion this must not cause', () => {
  beforeEach(() => { vi.resetModules(); logError.mockClear(); idSeq = 0; });

  it('allows a capTranscript-style shrink that drops messages AND tokens', async () => {
    // capTranscript sheds the oldest messages once a transcript passes its
    // bound. Fewer messages, fewer tokens, and entirely correct. A plain
    // "never shrink" rule — on tokens or on message count — would refuse this.
    seed(100);
    const saved = await save(94);            // six oldest shed
    expect(saved).toBe(CONV);
    expect(rows[0].message_count).toBe(94);
  });

  it('allows the worst single-turn drop capTranscript can actually produce', async () => {
    // It stops the moment it is back under the bound, so its largest possible
    // drop is one oversized message — ~6% of the transcript, not half of it.
    seed(100);
    expect(await save(93)).toBe(CONV);
  });

  it('draws the line at half, which is 8x beyond anything capTranscript does', async () => {
    seed(100);
    expect(await save(51)).toBe(CONV);       // just inside
    seed(100);
    expect(await save(49)).toBeNull();       // just outside
  });
});

describe('ordinary writes are unaffected', () => {
  beforeEach(() => { vi.resetModules(); logError.mockClear(); idSeq = 0; });

  it('allows growth', async () => {
    seed(10);
    expect(await save(12)).toBe(CONV);
    expect(rows[0].message_count).toBe(12);
  });

  it('allows an identical re-save, so a retry is not refused', async () => {
    // The migration specifies `<=`, not `<`, for exactly this.
    seed(10);
    expect(await save(10)).toBe(CONV);
  });

  it('still inserts for a genuinely stale id', async () => {
    // The one case that SHOULD reach the insert, and now the only one.
    seed(10);
    const saved = await save(3, 400, 'conv-that-does-not-exist');
    expect(saved).toBe('conv-1');
    expect(inserted).toHaveLength(1);
  });

  it('still inserts when no id is supplied at all', async () => {
    seed(10);
    expect(await save(2, 400, undefined)).toBe('conv-1');
    expect(inserted).toHaveLength(1);
  });

  it('measures content, not message count — many tiny messages do not outweigh few large ones', async () => {
    // 40 one-word replies carry less than 5 turns of tool results. Guarding on
    // tokens is why this is refused; a message-count guard would wave it
    // through as "more messages".
    seed(5, 20_000);                          // 5 large messages
    expect(await save(40, 100)).toBeNull();   // 40 tiny ones
  });
});

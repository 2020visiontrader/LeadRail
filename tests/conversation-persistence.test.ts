// A conversation is the only thing in this product the user cannot reproduce.
// These pin the two ways it was being lost — both of which came from an error
// value being discarded and mistaken for "nothing there".

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
vi.mock('@/lib/db', () => ({ supabase: { from: (...a: any[]) => mockFrom(...a) }, dbReady: () => true }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('./embeddings', () => ({ embedPassage: vi.fn(), embedQuery: vi.fn(), toPgVector: vi.fn() }));

/** Minimal supabase-js chain stub: every filter returns `this`, and the
 *  terminal call resolves to whatever this builder was given. */
function builder(result: any) {
  const b: any = {};
  // `lte` is the shrink guard's filter (see saveConversation). Omitting it made
  // the guarded update throw a TypeError that the outer catch swallowed as null.
  for (const m of ['select', 'update', 'insert', 'eq', 'lte', 'order', 'limit', 'in', 'ilike']) {
    b[m] = () => b;
  }
  b.maybeSingle = async () => result;
  b.single = async () => result;
  b.then = (res: any) => Promise.resolve(result).then(res);
  return b;
}

describe('saveConversation', () => {
  beforeEach(() => { vi.resetModules(); mockFrom.mockReset(); });

  it('does not create a second row when the update errors', async () => {
    // THE FORK. supabase-js reports failures in the result object rather than
    // throwing, and the error used to be destructured away — so a failed update
    // was indistinguishable from one matching no rows, and the insert below it
    // created a duplicate carrying the full history under a new id. The chat
    // "disappeared": intact, but under an id nothing pointed at.
    const inserts: any[] = [];
    mockFrom.mockImplementation(() => ({
      update: () => builder({ data: null, error: { message: 'timeout' } }),
      insert: (row: any) => { inserts.push(row); return builder({ data: { id: 'NEW' }, error: null }); },
      select: () => builder({ data: null, error: null }),
    }));
    const { saveConversation } = await import('@/lib/agent/memory');
    const id = await saveConversation({
      id: 'EXISTING', accountId: 'acct', transcript: [{ role: 'user', content: 'hi' } as any],
    });
    expect(inserts).toHaveLength(0);
    expect(id).toBeNull();
  });

  it('still inserts when the id genuinely matches no row', async () => {
    // No error and no row USED to mean only one thing — a stale or foreign id,
    // where a new conversation is right. Since the shrink guard was attached it
    // has two meanings, because a refused write also matches no rows. So the
    // save now RE-READS to tell them apart, and this mock has to model that
    // read: `select` returning no row is what "genuinely stale" looks like.
    //
    // The distinction matters enormously. If a refused write were mistaken for
    // a stale id, the insert below would fork the conversation — the precise
    // failure the guard exists to prevent. See tests/conversation-write-guard.
    const inserts: any[] = [];
    mockFrom.mockImplementation(() => ({
      update: () => builder({ data: null, error: null }),
      select: () => builder({ data: null, error: null }),   // the row is really gone
      insert: (row: any) => { inserts.push(row); return builder({ data: { id: 'NEW' }, error: null }); },
    }));
    const { saveConversation } = await import('@/lib/agent/memory');
    const id = await saveConversation({
      id: 'STALE', accountId: 'acct', transcript: [{ role: 'user', content: 'hi' } as any],
    });
    expect(id).toBe('NEW');
    expect(inserts).toHaveLength(1);
  });

  it('records the message count alongside the transcript', async () => {
    const updates: any[] = [];
    mockFrom.mockImplementation(() => ({
      update: (row: any) => { updates.push(row); return builder({ data: { id: 'X' }, error: null }); },
    }));
    const { saveConversation } = await import('@/lib/agent/memory');
    await saveConversation({
      id: 'X', accountId: 'acct',
      transcript: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] as any,
    });
    expect(updates[0].message_count).toBe(2);
  });
});

describe('loadTranscriptResult', () => {
  beforeEach(() => { vi.resetModules(); mockFrom.mockReset(); });

  it('reports ok:false when the read fails, so a caller cannot write over it', async () => {
    // THE TRUNCATION. An errored read returned [], the turn appended one user
    // message, and the save replaced the whole conversation with that message.
    mockFrom.mockImplementation(() => builder({ data: null, error: { message: 'boom' } }));
    const { loadTranscriptResult } = await import('@/lib/agent/memory');
    const r = await loadTranscriptResult('some-id', 'acct');
    expect(r.ok).toBe(false);
    expect(r.messages).toEqual([]);
  });

  it('reports ok:true and empty for an unknown or foreign id', async () => {
    // Tenancy is unchanged: callers must not be able to tell "not yours" from
    // "empty", so this stays a successful read of nothing.
    mockFrom.mockImplementation(() => builder({ data: null, error: null }));
    const { loadTranscriptResult } = await import('@/lib/agent/memory');
    const r = await loadTranscriptResult('not-mine', 'acct');
    expect(r).toEqual({ messages: [], ok: true });
  });

  it('reports ok:true with no id at all', async () => {
    const { loadTranscriptResult } = await import('@/lib/agent/memory');
    expect(await loadTranscriptResult(undefined, 'acct')).toEqual({ messages: [], ok: true });
  });

  it('returns the stored messages on a good read', async () => {
    mockFrom.mockImplementation(() => builder({
      data: { transcript: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] },
      error: null,
    }));
    const { loadTranscriptResult } = await import('@/lib/agent/memory');
    const r = await loadTranscriptResult('id', 'acct');
    expect(r.ok).toBe(true);
    expect(r.messages).toHaveLength(2);
  });
});

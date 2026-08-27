// The bug this pins, from a real screenshot: "take a look at the doc attached"
// answered against a document the assistant had never been shown.
//
// The file uploaded perfectly. It was invisible because a file dropped into a
// NEW chat is uploaded before that chat has an id — conversationIdRef.current
// is undefined until the first turn streams back — so the row landed with
// conversation_id NULL, and listAttachments filters by conversation.
//
// Nothing errored anywhere. That is what made it survive: a successful upload,
// a successful turn, and an answer about a document that was never in the
// prompt.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: any[] = [];

vi.mock('@/lib/db', () => ({
  supabase: {
    from() {
      const q: any = {
        _f: [] as ((r: any) => boolean)[], _mode: 'select', _patch: null as any,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
        is(c: string, v: any) { q._f.push((r: any) => (v === null ? r[c] == null : r[c] === v)); return q; },
        in(c: string, v: any[]) { q._f.push((r: any) => v.includes(r[c])); return q; },
        gte() { return q; },
        or(expr: string) {
          // Mirrors PostgREST `or=(a.eq.X,b.eq.Y)` closely enough for the one
          // shape this code builds.
          const clauses = expr.split(',').map((c) => c.split('.'));
          q._f.push((r: any) => clauses.some(([col, , val]) => String(r[col]) === val));
          return q;
        },
        order() { return q; },
        limit() { return q; },
        update(p: any) { q._mode = 'update'; q._patch = p; return q; },
        then(resolve: any) {
          const matched = rows.filter((r) => q._f.every((f: any) => f(r)));
          if (q._mode === 'update') {
            for (const r of matched) Object.assign(r, q._patch);
            return resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
          }
          return resolve({ data: matched, error: null });
        },
      };
      return q;
    },
  },
  dbReady: () => true,
}));

const ACC = 'acct-1';
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function seed() {
  rows = [
    { id: A, account_id: ACC, conversation_id: null, filename: 'brief.txt', scope: 'conversation', extracted_text: 'hello', chars: 5, status: 'ready', bytes: 5, kind: 'text' },
    { id: B, account_id: ACC, conversation_id: 'conv-9', filename: 'other.txt', scope: 'conversation', extracted_text: 'x', chars: 1, status: 'ready', bytes: 1, kind: 'text' },
  ];
}

describe('an attachment dropped before the chat existed still reaches the prompt', () => {
  beforeEach(() => { vi.resetModules(); seed(); });

  it('binds an unbound attachment to the conversation that names it', async () => {
    const { bindAttachments } = await import('@/lib/documents/attachments');
    expect(await bindAttachments(ACC, [A], 'conv-1')).toBe(1);
    expect(rows.find((r) => r.id === A)!.conversation_id).toBe('conv-1');
  });

  it('NEVER steals an attachment already bound to another conversation', async () => {
    const { bindAttachments } = await import('@/lib/documents/attachments');
    expect(await bindAttachments(ACC, [B], 'conv-1')).toBe(0);
    expect(rows.find((r) => r.id === B)!.conversation_id).toBe('conv-9');
  });

  it('is scoped by account — an id from another tenant binds nothing', async () => {
    const { bindAttachments } = await import('@/lib/documents/attachments');
    expect(await bindAttachments('other-account', [A], 'conv-1')).toBe(0);
    expect(rows.find((r) => r.id === A)!.conversation_id).toBeNull();
  });

  it('reads a named attachment even when it is bound to nothing — the FIRST turn', async () => {
    // There is no conversation id yet on the first message of a new chat, so
    // binding cannot have happened. Reading the named ids directly is what
    // makes the file visible on the turn it was sent with.
    const { attachmentsByIds } = await import('@/lib/documents/attachments');
    const found = await attachmentsByIds(ACC, [A]);
    expect(found).toHaveLength(1);
    expect(found[0].filename).toBe('brief.txt');
  });

  it('ignores a malformed id rather than querying with it', async () => {
    const { attachmentsByIds, bindAttachments } = await import('@/lib/documents/attachments');
    expect(await attachmentsByIds(ACC, ['not-a-uuid', "'; drop table --"])).toEqual([]);
    expect(await bindAttachments(ACC, ['not-a-uuid'], 'conv-1')).toBe(0);
  });
});

describe('the account library reaches every chat', () => {
  beforeEach(() => { vi.resetModules(); seed(); });

  it('returns a library document from a conversation that never saw it', async () => {
    // The other half of the same problem: a document saved once had to be
    // re-uploaded per chat, and a plan step or scheduled run could never see
    // one at all.
    rows.push({
      id: '33333333-3333-3333-3333-333333333333', account_id: ACC,
      conversation_id: 'some-other-chat', filename: 'brand-book.pdf',
      scope: 'library', extracted_text: 'voice rules', chars: 11, status: 'ready', bytes: 11, kind: 'pdf',
    });
    const { listAttachments } = await import('@/lib/documents/attachments');
    const found = await listAttachments(ACC, 'conv-1');
    expect(found.some((f: any) => f.filename === 'brand-book.pdf')).toBe(true);
  });
});

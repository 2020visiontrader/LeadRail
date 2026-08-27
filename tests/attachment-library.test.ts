// Migration 067 gave assistant_attachments a `scope` (conversation | library)
// and a `title`, and lib/documents/attachments.ts already reads scope='library'
// into every conversation's context — but nothing could ever SET scope, so the
// column sat at its default forever and the feature was unreachable. These
// tests pin the writer (`updateAttachment`) and the account-wide reader
// (`listAllAttachments`) that make it reachable.
//
// The two things worth pinning hardest:
//   1. `scope` feeds a column with a CHECK constraint. A bad value has to be
//      rejected HERE, before it reaches Postgres — a constraint violation is a
//      500 with no useful message, where a validated reject is a 400 the
//      caller can act on.
//   2. Account scope belongs INSIDE the query, never taken on trust. An id
//      from another tenant has to behave exactly like an id that does not
//      exist at all — no existence oracle.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: any[] = [];

vi.mock('@/lib/db', () => ({
  supabase: {
    from() {
      const q: any = {
        _f: [] as ((r: any) => boolean)[], _mode: 'select', _patch: null as any,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
        in(c: string, v: any[]) { q._f.push((r: any) => v.includes(r[c])); return q; },
        order() { return q; },
        update(p: any) { q._mode = 'update'; q._patch = p; return q; },
        // maybeSingle is TERMINAL — same as the real supabase-js client — so
        // it resolves immediately instead of waiting on a further .then().
        async maybeSingle() {
          const matched = rows.filter((r) => q._f.every((f: any) => f(r)));
          if (q._mode === 'update') {
            for (const r of matched) Object.assign(r, q._patch);
          }
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) {
          const matched = rows.filter((r) => q._f.every((f: any) => f(r)));
          return resolve({ data: matched, error: null });
        },
      };
      return q;
    },
  },
  dbReady: () => true,
}));

const ACC = 'acct-1';
const OTHER_ACC = 'acct-2';
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function seed() {
  rows = [
    {
      id: A, account_id: ACC, conversation_id: 'conv-1', filename: 'brand-book.pdf',
      title: null, scope: 'conversation', mime_type: 'application/pdf', bytes: 1024,
      kind: 'pdf', status: 'ready', note: null, chars: 500, created_at: '2026-08-20T00:00:00Z',
    },
    {
      id: B, account_id: ACC, conversation_id: null, filename: 'pricing.csv',
      title: 'Q3 pricing', scope: 'library', mime_type: 'text/csv', bytes: 200,
      kind: 'csv', status: 'ready', note: null, chars: 90, created_at: '2026-08-25T00:00:00Z',
    },
  ];
}

describe('updateAttachment — scope validation', () => {
  beforeEach(() => { vi.resetModules(); seed(); });

  it('writes a valid scope value', async () => {
    const { updateAttachment } = await import('@/lib/documents/attachments');
    const updated = await updateAttachment(ACC, A, { scope: 'library' });
    expect(updated?.scope).toBe('library');
    expect(rows.find((r) => r.id === A)!.scope).toBe('library');
  });

  it('rejects a value the CHECK constraint would reject, before it reaches the query', async () => {
    const { updateAttachment } = await import('@/lib/documents/attachments');
    await expect(updateAttachment(ACC, A, { scope: 'public' as any })).rejects.toThrow(/scope must be one of/i);
    // Nothing was written — the row is untouched.
    expect(rows.find((r) => r.id === A)!.scope).toBe('conversation');
  });

  it('rejects an empty string, not just an unrelated word', async () => {
    const { updateAttachment } = await import('@/lib/documents/attachments');
    await expect(updateAttachment(ACC, A, { scope: '' as any })).rejects.toThrow(/scope must be one of/i);
  });
});

describe('updateAttachment — account isolation', () => {
  beforeEach(() => { vi.resetModules(); seed(); });

  it('an id from another account updates nothing and returns null', async () => {
    const { updateAttachment } = await import('@/lib/documents/attachments');
    const result = await updateAttachment(OTHER_ACC, A, { scope: 'library' });
    expect(result).toBeNull();
    // The row belonging to the real account is untouched — the call did not
    // silently succeed against the wrong tenant's row.
    expect(rows.find((r) => r.id === A)!.scope).toBe('conversation');
  });

  it('behaves identically for a cross-account id and a nonexistent id — no existence oracle', async () => {
    const { updateAttachment } = await import('@/lib/documents/attachments');
    const crossAccount = await updateAttachment(OTHER_ACC, A, { title: 'stolen' });
    const nonexistent = await updateAttachment(ACC, '99999999-9999-9999-9999-999999999999', { title: 'ghost' });
    expect(crossAccount).toBeNull();
    expect(nonexistent).toBeNull();
  });
});

describe('updateAttachment — title trim and clear', () => {
  beforeEach(() => { vi.resetModules(); seed(); });

  it('trims surrounding whitespace before writing', async () => {
    const { updateAttachment } = await import('@/lib/documents/attachments');
    const updated = await updateAttachment(ACC, A, { title: '  Brand Book v2  ' });
    expect(updated?.title).toBe('Brand Book v2');
  });

  it('treats an empty string as clearing the title to null, not storing blank text', async () => {
    const { updateAttachment } = await import('@/lib/documents/attachments');
    const updated = await updateAttachment(ACC, B, { title: '' });
    expect(updated?.title).toBeNull();
  });

  it('treats an all-whitespace string the same as empty', async () => {
    const { updateAttachment } = await import('@/lib/documents/attachments');
    const updated = await updateAttachment(ACC, B, { title: '   ' });
    expect(updated?.title).toBeNull();
  });

  it('an explicit null clears the title directly', async () => {
    const { updateAttachment } = await import('@/lib/documents/attachments');
    const updated = await updateAttachment(ACC, B, { title: null });
    expect(updated?.title).toBeNull();
  });
});

describe('listAllAttachments — the account-wide inventory', () => {
  beforeEach(() => { vi.resetModules(); seed(); });

  it('returns every attachment on the account regardless of conversation or scope', async () => {
    const { listAllAttachments } = await import('@/lib/documents/attachments');
    const found = await listAllAttachments(ACC);
    expect(found.map((a) => a.id).sort()).toEqual([A, B].sort());
  });

  it('is scoped by account — another tenant sees nothing', async () => {
    const { listAllAttachments } = await import('@/lib/documents/attachments');
    const found = await listAllAttachments(OTHER_ACC);
    expect(found).toEqual([]);
  });
});

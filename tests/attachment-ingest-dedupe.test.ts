// C5 residual — create-time dedupe.
//
// attachmentContextBlock already dedupes identical extracted_text at RENDER
// time (tests/attachment-context-turns.test.ts), but nothing stopped the SAME
// text being uploaded and stored over and over: production held a single
// 34,456-char voice transcript nine times — three unbound rows plus two
// copies each in two conversations, each with its own storage object.
//
// These tests pin ingestAttachment's create-time half of that fix:
//   - an identical, unbound row is bound and handed back — no upload, no insert
//   - an identical row already bound to the SAME conversation is handed back as-is
//   - an identical row bound to a DIFFERENT conversation gets one new row that
//     reuses the existing storage_path — no second upload
//   - different text takes the ordinary upload+insert path
//   - a lookup failure never blocks the ordinary path
//   - deleteAttachment's storage-object guard: a shared storage_path is only
//     removed once nothing else references it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// A tiny fake `assistant_attachments` table + storage, covering exactly the
// query shapes lib/documents/attachments.ts issues: select().eq*().limit(),
// update().eq*().select().maybeSingle(), insert([...]).select().single(),
// and storage.from(bucket).remove([...]).
// ---------------------------------------------------------------------------
interface Row { [k: string]: any }
let rows: Row[] = [];
let idSeq = 0;
let removeCalls: string[][] = [];
let throwOnLookup = false;

function resetDb() {
  rows = [];
  idSeq = 0;
  removeCalls = [];
  throwOnLookup = false;
}

function makeClient() {
  return {
    from(table: string) {
      const q: any = {
        _filters: [] as ((r: Row) => boolean)[],
        _limit: undefined as number | undefined,
        _mode: 'select' as 'select' | 'update' | 'insert',
        _patch: null as Row | null,
        _insertRows: null as Row[] | null,
        select() {
          if (throwOnLookup && table === 'assistant_attachments' && q._mode === 'select') {
            throw new Error('simulated DB error');
          }
          return q;
        },
        eq(c: string, v: any) { q._filters.push((r: Row) => r[c] === v); return q; },
        neq(c: string, v: any) { q._filters.push((r: Row) => r[c] !== v); return q; },
        limit(n: number) { q._limit = n; return q; },
        update(p: Row) { q._mode = 'update'; q._patch = p; return q; },
        insert(payload: Row | Row[]) {
          q._mode = 'insert';
          q._insertRows = Array.isArray(payload) ? payload : [payload];
          return q;
        },
        maybeSingle: async () => {
          const matched = rows.filter((r) => q._filters.every((f: any) => f(r)));
          if (q._mode === 'update') {
            for (const r of matched) Object.assign(r, q._patch);
            return { data: matched[0] ? { ...matched[0] } : null, error: null };
          }
          return { data: matched[0] ? { ...matched[0] } : null, error: null };
        },
        single: async () => {
          if (q._mode === 'insert') {
            const created = q._insertRows!.map((p: Row) => ({
              id: `att-${++idSeq}`,
              created_at: new Date().toISOString(),
              note: p.note ?? null,
              conversation_id: p.conversation_id ?? null,
              ...p,
            }));
            rows.push(...created);
            return { data: { ...created[0] }, error: null };
          }
          const matched = rows.filter((r) => q._filters.every((f: any) => f(r)));
          return { data: matched[0] ? { ...matched[0] } : null, error: null };
        },
        delete() { q._mode = 'delete'; return q; },
        then(resolve: any) {
          if (q._mode === 'delete') {
            const before = rows.length;
            rows = rows.filter((r) => !q._filters.every((f: any) => f(r)));
            return resolve({ data: null, error: null, count: before - rows.length });
          }
          let matched = rows.filter((r) => q._filters.every((f: any) => f(r)));
          if (q._limit != null) matched = matched.slice(0, q._limit);
          return resolve({ data: matched.map((r) => ({ ...r })), error: null });
        },
      };
      return q;
    },
    storage: {
      from(bucket: string) {
        return {
          remove: async (paths: string[]) => { removeCalls.push(paths); return { error: null }; },
        };
      },
    },
  };
}

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));

const putPrivate = vi.fn(async (_bucket: string, path: string, _bytes: Buffer, _mime?: string) => ({ path }));
const ensurePrivateBucket = vi.fn(async () => {});
const signUrl = vi.fn(async () => 'https://example.com/signed');
vi.mock('@/lib/storage', () => ({
  putPrivate: (...a: any[]) => (putPrivate as any)(...a),
  ensurePrivateBucket: (...a: any[]) => (ensurePrivateBucket as any)(...a),
  signUrl: (...a: any[]) => (signUrl as any)(...a),
}));

let deckResult = { ok: true, text: 'default text' } as { ok: boolean; text?: string; note?: string };
const extractDeckText = vi.fn(async (_name: string, _bytes: Buffer, _cap: number) => deckResult);
vi.mock('@/lib/ai/deck', () => ({
  extractDeckText: (...a: any[]) => (extractDeckText as any)(...a),
  isSupportedDeck: (name: string) => /\.(pdf|docx|pptx|xlsx|csv|txt|md|json)$/i.test(name),
}));

const ACC = 'acct-1';
const TEXT = 'Identical transcript content, byte for byte, uploaded more than once.';
const OTHER_TEXT = 'Completely different content — this is not a duplicate of anything.';
const BYTES = Buffer.byteLength(TEXT);

function seedDupe(over: Partial<Row> = {}): Row {
  const row: Row = {
    id: 'att-original',
    account_id: ACC,
    conversation_id: null,
    filename: 'transcript.txt',
    mime_type: 'text/plain',
    bytes: BYTES,
    storage_path: `${ACC}/original.txt`,
    kind: 'txt',
    extracted_text: TEXT,
    chars: TEXT.length,
    status: 'ready',
    note: null,
    created_at: new Date().toISOString(),
    ...over,
  };
  rows.push(row);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDb();
  deckResult = { ok: true, text: TEXT };
});

describe('ingestAttachment — create-time dedupe (C5 residual)', () => {
  it('identical text + unbound existing row: no upload, no insert, row returned and bound', async () => {
    const dupe = seedDupe({ conversation_id: null });
    const { ingestAttachment } = await import('@/lib/documents/attachments');

    const result = await ingestAttachment({
      accountId: ACC,
      conversationId: 'conv-1',
      filename: 'new-upload.txt',
      bytes: Buffer.from(TEXT),
      mimeType: 'text/plain',
    });

    expect(putPrivate).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1); // no new row inserted
    expect(result.id).toBe(dupe.id);
    expect(result.conversation_id).toBe('conv-1'); // bound as part of returning it
    expect(rows[0].conversation_id).toBe('conv-1'); // the underlying row was actually updated
  });

  it('identical text already bound to the SAME conversation: returned as-is', async () => {
    const dupe = seedDupe({ conversation_id: 'conv-1' });
    const { ingestAttachment } = await import('@/lib/documents/attachments');

    const result = await ingestAttachment({
      accountId: ACC,
      conversationId: 'conv-1',
      filename: 'new-upload.txt',
      bytes: Buffer.from(TEXT),
      mimeType: 'text/plain',
    });

    expect(putPrivate).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(result.id).toBe(dupe.id);
    expect(result.conversation_id).toBe('conv-1');
  });

  it('identical text bound to a DIFFERENT conversation: one new row reusing storage_path, no upload', async () => {
    const dupe = seedDupe({ conversation_id: 'conv-A' });
    const { ingestAttachment } = await import('@/lib/documents/attachments');

    const result = await ingestAttachment({
      accountId: ACC,
      conversationId: 'conv-B',
      filename: 'new-upload.txt',
      bytes: Buffer.from(TEXT),
      mimeType: 'text/plain',
    });

    expect(putPrivate).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2); // one new row
    expect(result.id).not.toBe(dupe.id);
    expect(result.conversation_id).toBe('conv-B');
    expect(result.storage_path).toBe(dupe.storage_path); // same object, no second upload
    expect(result.extracted_text).toBe(TEXT);
  });

  it('different text: normal upload+insert path, dedupe lookup finds nothing', async () => {
    seedDupe({ conversation_id: 'conv-A' });
    deckResult = { ok: true, text: OTHER_TEXT };
    const { ingestAttachment } = await import('@/lib/documents/attachments');

    const result = await ingestAttachment({
      accountId: ACC,
      conversationId: 'conv-B',
      filename: 'different.txt',
      bytes: Buffer.from(OTHER_TEXT),
      mimeType: 'text/plain',
    });

    expect(putPrivate).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(result.storage_path).not.toBe(rows[0].storage_path);
    expect(result.extracted_text).toBe(OTHER_TEXT);
  });

  it('a lookup failure never blocks the ordinary upload+insert path', async () => {
    seedDupe({ conversation_id: null });
    throwOnLookup = true;
    const { ingestAttachment } = await import('@/lib/documents/attachments');

    const result = await ingestAttachment({
      accountId: ACC,
      conversationId: 'conv-1',
      filename: 'new-upload.txt',
      bytes: Buffer.from(TEXT),
      mimeType: 'text/plain',
    });

    expect(putPrivate).toHaveBeenCalledTimes(1); // fell through to the normal path
    expect(rows).toHaveLength(2); // a second row was created, not deduped
    expect(result.conversation_id).toBe('conv-1');
  });

  it('an identical library-scoped document is never reused or rebound; the upload takes the normal path', async () => {
    // A library row has conversation_id NULL by design (account-wide reach,
    // not "unbound and waiting to be claimed" — see migration 067). Without
    // excluding scope='library' from the lookup, this would look exactly
    // like the unbound-dupe case in the first test and get "bound" to
    // conv-1, silently turning the account's library document into a
    // conversation-scoped one.
    const libraryDoc = seedDupe({ id: 'att-library', conversation_id: null, scope: 'library' });
    const { ingestAttachment } = await import('@/lib/documents/attachments');

    const result = await ingestAttachment({
      accountId: ACC,
      conversationId: 'conv-1',
      filename: 'new-upload.txt',
      bytes: Buffer.from(TEXT),
      mimeType: 'text/plain',
    });

    expect(putPrivate).toHaveBeenCalledTimes(1); // normal upload, not reused
    expect(rows).toHaveLength(2); // a genuinely new row, not a rebind
    expect(result.id).not.toBe(libraryDoc.id);
    expect(result.conversation_id).toBe('conv-1');
    // The library row itself is untouched — still library-scoped, still unbound.
    expect(rows.find((r) => r.id === libraryDoc.id)?.scope).toBe('library');
    expect(rows.find((r) => r.id === libraryDoc.id)?.conversation_id).toBeNull();
  });

  it('images are never deduped, even with identical bytes on file', async () => {
    // Seed a "duplicate" row that happens to share chars/bytes but is an
    // image status — irrelevant, since ingestAttachment never even attempts
    // the lookup for an image upload (no extracted text to compare).
    const { ingestAttachment } = await import('@/lib/documents/attachments');
    const bytes = Buffer.from([1, 2, 3, 4]);
    seedDupe({ id: 'att-img-1', chars: 0, bytes: bytes.length, status: 'image', extracted_text: null, kind: 'png' });

    const result = await ingestAttachment({
      accountId: ACC,
      conversationId: 'conv-1',
      filename: 'photo.png',
      bytes,
      mimeType: 'image/png',
    });

    expect(putPrivate).toHaveBeenCalledTimes(1); // uploaded, not deduped
    expect(result.status).toBe('image');
    expect(result.id).not.toBe('att-img-1');
  });
});

describe('deleteAttachment — shared storage_path guard', () => {
  it('does NOT remove the storage object while another row still references it', async () => {
    seedDupe({ id: 'att-1', conversation_id: 'conv-A', storage_path: `${ACC}/shared.txt` });
    seedDupe({ id: 'att-2', conversation_id: 'conv-B', storage_path: `${ACC}/shared.txt` });
    const { deleteAttachment } = await import('@/lib/documents/attachments');

    await deleteAttachment(ACC, 'att-1');

    expect(removeCalls).toHaveLength(0); // att-2 still points at the object
    expect(rows.find((r) => r.id === 'att-1')).toBeUndefined(); // row itself is gone
    expect(rows.find((r) => r.id === 'att-2')).toBeTruthy(); // the other row is untouched
  });

  it('removes the storage object once it is the LAST row referencing it', async () => {
    seedDupe({ id: 'att-1', conversation_id: 'conv-A', storage_path: `${ACC}/solo.txt` });
    const { deleteAttachment } = await import('@/lib/documents/attachments');

    await deleteAttachment(ACC, 'att-1');

    expect(removeCalls).toEqual([[`${ACC}/solo.txt`]]);
    expect(rows).toHaveLength(0);
  });
});

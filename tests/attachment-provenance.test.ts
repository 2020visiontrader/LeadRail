// Migration 076 — attachment provenance that survives a reload.
//
// THE DEFECT THIS PINS: "did you actually read my PDF?" was unanswerable
// after a reload, because the only place a file was ever tied to a message
// was React state that vanished on remount. This suite proves the durable
// path: a stable id on the transcript entry (lib/agent/transcript-store.ts),
// preserved verbatim across every save (lib/agent/memory.ts), plus a binding
// row (lib/documents/attachment-bindings.ts) that survives independently of
// the transcript content.
//
// THE ACCEPTANCE TEST THAT MATTERS is 'names the file after a reload from the
// database' below — a conversation with an attachment is saved, then
// re-loaded, and the rehydrated turn still names the file it was given.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// A tiny multi-table fake, shared by every test below, so the "reload" test
// can exercise memory.ts (agent_conversations) and attachment-bindings.ts
// (attachment_bindings) against the SAME in-memory database — proving the
// two actually agree on a message id, not just that each compiles in
// isolation.
// ---------------------------------------------------------------------------
interface Row { [k: string]: any }
let tables: Record<string, Row[]> = {};
let idSeq = 0;

function resetDb() {
  tables = { agent_conversations: [], attachment_bindings: [], assistant_attachments: [] };
  idSeq = 0;
}

function makeClient() {
  return {
    from(table: string) {
      const rows = () => (tables[table] ||= []);
      const q: any = {
        _f: [] as ((r: Row) => boolean)[], _mode: 'select', _patch: null as Row | null,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: Row) => r[c] === v); return q; },
        // migration 069's soft-delete exclusion filter, and the general NULL
        // filter attachment-bindings.ts uses for message_id.
        is(c: string, v: any) {
          q._f.push((r: Row) => (v === null ? (r[c] === null || r[c] === undefined) : r[c] === v));
          return q;
        },
        // migration 059's shrink guard.
        lte(c: string, v: any) { q._f.push((r: Row) => (r[c] ?? 0) <= v); return q; },
        order() { return q; },
        limit() { return q; },
        insert(payload: Row | Row[]) {
          const arr = Array.isArray(payload) ? payload : [payload];
          const created = arr.map((p) => ({
            id: `${table}-${++idSeq}`,
            created_at: new Date().toISOString(),
            bound_at: new Date().toISOString(),
            status: 'bound',
            ...p,
          }));
          // Mirrors migration 076's uniq_attachment_binding_live partial
          // unique index for the one table it protects: a live row already
          // matching (attachment_id, COALESCE(message_id, sentinel), scope)
          // makes the insert fail with 23505, exactly like Postgres would.
          if (table === 'attachment_bindings') {
            for (const c of created) {
              const dupe = rows().find((r) =>
                r.status === 'bound' &&
                r.attachment_id === c.attachment_id &&
                r.scope === c.scope &&
                (r.message_id ?? null) === (c.message_id ?? null),
              );
              if (dupe) {
                return {
                  select: () => ({
                    maybeSingle: async () => ({
                      data: null,
                      error: { code: '23505', message: 'duplicate key value violates unique constraint "uniq_attachment_binding_live"' },
                    }),
                  }),
                };
              }
            }
          }
          rows().push(...created);
          return {
            select: () => ({
              maybeSingle: async () => ({ data: created[0] ?? null, error: null }),
              single: async () => ({ data: created[0] ?? null, error: null }),
            }),
          };
        },
        update(p: Row) { q._mode = 'update'; q._patch = p; return q; },
        maybeSingle: async () => {
          const matched = rows().filter((r) => q._f.every((f: any) => f(r)));
          if (q._mode === 'update') {
            for (const r of matched) Object.assign(r, q._patch);
            return { data: matched[0] ? { id: matched[0].id } : null, error: null };
          }
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) {
          const matched = rows().filter((r) => q._f.every((f: any) => f(r)));
          if (q._mode === 'update') {
            for (const r of matched) Object.assign(r, q._patch);
            return resolve({ data: matched.map((r) => ({ ...r })), error: null });
          }
          return resolve({ data: matched, error: null });
        },
      };
      return q;
    },
  };
}

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));
const ACC = 'acct-1';

beforeEach(() => { vi.resetModules(); resetDb(); });

// ---------------------------------------------------------------------------
// Part 1 — stable ids: minted once, preserved verbatim across a rewrite.
// ---------------------------------------------------------------------------
describe('transcript-store: mintMessageId / ensureMessageIds / toWireMessages', () => {
  it('mints a distinct id for every entry that lacks one', async () => {
    const { ensureMessageIds } = await import('@/lib/agent/transcript-store');
    const out = ensureMessageIds([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    expect(out[0].id).toBeTruthy();
    expect(out[1].id).toBeTruthy();
    expect(out[0].id).not.toBe(out[1].id);
  });

  it('preserves an id already present rather than minting a new one', async () => {
    const { ensureMessageIds } = await import('@/lib/agent/transcript-store');
    const out = ensureMessageIds([{ role: 'user', content: 'a', id: 'fixed-id-1' }]);
    expect(out[0].id).toBe('fixed-id-1');
  });

  it('never mutates its input array', async () => {
    const { ensureMessageIds } = await import('@/lib/agent/transcript-store');
    const input = [{ role: 'user' as const, content: 'a' }];
    ensureMessageIds(input);
    expect((input[0] as any).id).toBeUndefined();
  });

  it('toWireMessages strips id and every other storage-only field', async () => {
    const { toWireMessages } = await import('@/lib/agent/transcript-store');
    const wire = toWireMessages([{ role: 'user', content: 'hello', id: 'should-not-leak' } as any]);
    expect(wire).toEqual([{ role: 'user', content: 'hello' }]);
    expect(Object.keys(wire[0])).toEqual(['role', 'content']);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — saveConversation mints once, preserves on every subsequent write,
// which is what makes ids survive the write race the migration's header
// describes (transcript is replaced WHOLE on every save).
// ---------------------------------------------------------------------------
describe('saveConversation preserves ids across a save that rewrites the transcript', () => {
  it('mints ids on first save', async () => {
    const { saveConversation, loadConversation } = await import('@/lib/agent/memory');
    const id = await saveConversation({
      accountId: ACC,
      transcript: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
    expect(id).toBeTruthy();
    const row = await loadConversation(id!, ACC);
    expect(row?.transcript?.[0]?.id).toBeTruthy();
    expect(row?.transcript?.[1]?.id).toBeTruthy();
  });

  it('mint once, never renumber — the SAME id survives a second save that appends a message', async () => {
    const { saveConversation, loadConversation } = await import('@/lib/agent/memory');
    const id = await saveConversation({
      accountId: ACC,
      transcript: [{ role: 'user', content: 'hi' }],
    });
    const first = await loadConversation(id!, ACC);
    const originalId = first!.transcript![0].id;
    expect(originalId).toBeTruthy();

    // Simulate the next turn: load, append, save back — exactly what
    // app/api/agent/route.ts does every turn.
    const appended = [...first!.transcript!, { role: 'assistant' as const, content: 'reply' }];
    await saveConversation({ id: id!, accountId: ACC, transcript: appended });

    const second = await loadConversation(id!, ACC);
    expect(second!.transcript![0].id).toBe(originalId); // preserved, not reminted
    expect(second!.transcript![1].id).toBeTruthy();      // the new one got its own
    expect(second!.transcript![1].id).not.toBe(originalId);
  });

  it('a caller-supplied id (minted before the turn ran) is preserved verbatim', async () => {
    // This is the exact shape app/api/agent/route.ts relies on: it mints
    // userMessageId BEFORE calling runAgent so it can bind an attachment to
    // it in the same request, then that id must survive the save unchanged.
    const { saveConversation, loadConversation } = await import('@/lib/agent/memory');
    const id = await saveConversation({
      accountId: ACC,
      transcript: [{ role: 'user', content: 'here is my file', id: 'minted-up-front' }],
    });
    const row = await loadConversation(id!, ACC);
    expect(row!.transcript![0].id).toBe('minted-up-front');
  });
});

// ---------------------------------------------------------------------------
// Part 3 — attachment_bindings: bind / duplicate retry / release.
// ---------------------------------------------------------------------------
describe('attachment bindings', () => {
  it('binds an attachment to a specific message', async () => {
    const { bindAttachmentToMessage } = await import('@/lib/documents/attachment-bindings');
    const binding = await bindAttachmentToMessage(ACC, 'att-1', 'conv-1', 'msg-1');
    expect(binding).toBeTruthy();
    expect(binding!.status).toBe('bound');
    expect(binding!.attachment_id).toBe('att-1');
    expect(binding!.message_id).toBe('msg-1');
    expect(binding!.scope).toBe('message');
  });

  it('a retry does NOT create a second live binding — the unique index bites', async () => {
    const { bindAttachmentToMessage, listBindingsForMessage } = await import('@/lib/documents/attachment-bindings');
    const first = await bindAttachmentToMessage(ACC, 'att-1', 'conv-1', 'msg-1');
    const retry = await bindAttachmentToMessage(ACC, 'att-1', 'conv-1', 'msg-1'); // e.g. a client double-submit
    expect(retry).toBeTruthy();
    expect(retry!.id).toBe(first!.id); // same row, not a new one
    const live = await listBindingsForMessage(ACC, 'conv-1', 'msg-1');
    expect(live).toHaveLength(1);
  });

  it('binding the SAME attachment to a DIFFERENT message is not treated as a duplicate', async () => {
    const { bindAttachmentToMessage } = await import('@/lib/documents/attachment-bindings');
    const a = await bindAttachmentToMessage(ACC, 'att-1', 'conv-1', 'msg-1');
    const b = await bindAttachmentToMessage(ACC, 'att-1', 'conv-1', 'msg-2');
    expect(a!.id).not.toBe(b!.id);
  });

  it('releasing a binding leaves the transcript untouched', async () => {
    const { saveConversation, loadConversation } = await import('@/lib/agent/memory');
    const { bindAttachmentToMessage, releaseAttachmentBinding, listBindingsForMessage } =
      await import('@/lib/documents/attachment-bindings');

    const convId = await saveConversation({
      accountId: ACC,
      transcript: [{ role: 'user', content: 'see attached', id: 'msg-1' }],
    });
    // Deep-cloned, not just read: the fake DB (like a real one under any ORM
    // that doesn't copy on select) can hand back the SAME object a later
    // mutation touches. Comparing live references would make this assertion
    // pass even if release corrupted the row — this bug was caught by this
    // test's own revert-check, which is exactly what that check is for.
    const before = await loadConversation(convId!, ACC);
    const beforeTranscript = JSON.parse(JSON.stringify(before!.transcript));

    const binding = await bindAttachmentToMessage(ACC, 'att-1', convId!, 'msg-1');
    const released = await releaseAttachmentBinding(ACC, binding!.id);
    expect(released).toBe(true);

    const stillLive = await listBindingsForMessage(ACC, convId!, 'msg-1');
    expect(stillLive).toHaveLength(0); // released, no longer "live"

    const after = await loadConversation(convId!, ACC);
    expect(after!.transcript).toEqual(beforeTranscript); // untouched
  });

  it('releasing is idempotent — releasing twice is not an error', async () => {
    const { bindAttachmentToMessage, releaseAttachmentBinding } = await import('@/lib/documents/attachment-bindings');
    const binding = await bindAttachmentToMessage(ACC, 'att-1', 'conv-1', 'msg-1');
    expect(await releaseAttachmentBinding(ACC, binding!.id)).toBe(true);
    expect(await releaseAttachmentBinding(ACC, binding!.id)).toBe(false); // already released, no row matched status='bound'
  });
});

// ---------------------------------------------------------------------------
// Part 4 — THE ACCEPTANCE TEST: a conversation with an attachment is saved,
// then re-loaded FROM THE DATABASE, and the rehydrated turn still names the
// file it was given.
// ---------------------------------------------------------------------------
describe('a reloaded conversation still names the file it was given', () => {
  it('names the file after a reload from the database', async () => {
    const { saveConversation, loadConversation } = await import('@/lib/agent/memory');
    const { bindAttachmentToMessage, listBindingsForMessage } = await import('@/lib/documents/attachment-bindings');

    // Seed the attachment row the way lib/documents/attachments.ts would.
    tables.assistant_attachments.push({
      id: 'att-1', account_id: ACC, filename: 'Q3-contract.pdf', kind: 'pdf', status: 'ready',
    });

    // Turn 1: the user sends a message with an attachment. The route mints
    // the message id BEFORE the turn runs (see app/api/agent/route.ts) so it
    // can bind the attachment to this exact exchange.
    const userMessageId = 'msg-turn-1-user';
    const convId = await saveConversation({
      accountId: ACC,
      transcript: [
        { role: 'user', content: 'What does this contract say about termination?', id: userMessageId },
        { role: 'assistant', content: 'It has a 30-day termination clause.' },
      ],
    });
    expect(convId).toBeTruthy();
    await bindAttachmentToMessage(ACC, 'att-1', convId!, userMessageId, {
      scope: 'message', role: 'user_upload', boundBy: 'user',
    });

    // --- Simulate a full reload: fresh process, fresh read from the DB. ---
    const reloaded = await loadConversation(convId!, ACC);
    expect(reloaded).toBeTruthy();
    const reloadedUserMessage = reloaded!.transcript!.find((m) => m.role === 'user');
    expect(reloadedUserMessage?.id).toBe(userMessageId); // the id survived the round trip

    // THE ANSWER TO "did you actually read my PDF?" — resolvable purely from
    // what the database has, with no React state and no live turn involved.
    const bindings = await listBindingsForMessage(ACC, convId!, reloadedUserMessage!.id!);
    expect(bindings).toHaveLength(1);
    const attachmentRow = tables.assistant_attachments.find((a) => a.id === bindings[0].attachment_id);
    expect(attachmentRow?.filename).toBe('Q3-contract.pdf');
  });
});

// ---------------------------------------------------------------------------
// Part 5 — no id leaks to providers. toWireMessages stripping id is proven
// above (Part 1); this pins the actual call sites in lib/agent/loop.ts so a
// future edit that reintroduces a bare `messages` (StoredMessage[], carrying
// `id`) into a generateChat call is caught here rather than discovered as a
// stricter provider rejecting a request, or a leaked id in model context.
// ---------------------------------------------------------------------------
describe('no StoredMessage id reaches a provider payload', () => {
  it('every generateChat call in loop.ts that sends the transcript wraps it in toWireMessages', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(process.cwd(), 'lib/agent/loop.ts'), 'utf8');

    // The old, dangerous shape: the raw StoredMessage[] transcript variable
    // handed straight to generateChat as `messages`, unwrapped. Must not
    // exist anywhere in the file.
    expect(src).not.toMatch(/generateChat\(\{[^}]*\bmessages,/s);
    expect(src).not.toMatch(/\bmessages:\s*messages\b(?!\))/); // `messages: messages` (not `toWireMessages(messages)`)

    // The four call sites that actually send the running transcript must
    // route it through the stripping helper.
    const wrapped = src.match(/toWireMessages\(messages\)/g) || [];
    expect(wrapped.length).toBeGreaterThanOrEqual(4);
  });
});

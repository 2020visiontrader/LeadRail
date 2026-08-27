// Migration 069: agent_conversations joins the soft-delete model already used
// by contacts/companies/deals/brands. Before this, the only way to remove one
// conversation was deleting the whole account (FK cascade) — no DELETE
// handler, no deleted_at column, no UI affordance.
//
// These pin: a soft-deleted conversation disappears from the list AND from
// the transcript read; deleting another account's conversation is
// indistinguishable from deleting an unknown one (no existence oracle, same
// contract loadConversation/loadTranscript already hold); and a save already
// in flight when a delete lands cannot resurrect the deleted conversation —
// neither by writing through to the deleted row nor by forking a fresh one
// from the stale in-flight content.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

interface Row { [k: string]: any }
let rows: Row[] = [];
let idSeq = 0;

/** Minimal PostgREST-shaped fake, generic enough for every query shape
 *  memory.ts issues: select/update/insert, eq/is/lt/lte/ilike filters,
 *  order+limit, and both `.maybeSingle()` and bare `await` (array) results. */
function makeClient() {
  return {
    from() {
      const q: any = {
        _f: [] as ((r: Row) => boolean)[],
        _mode: 'select' as 'select' | 'update' | 'insert',
        _patch: null as Row | null,
        _insertPayload: null as Row | null,
        _limit: Infinity,
        _orderCol: null as string | null,
        _desc: true,
        select() { return q; },
        eq(c: string, v: any) { q._f.push((r: Row) => r[c] === v); return q; },
        is(c: string, v: any) {
          q._f.push((r: Row) => (v === null ? (r[c] === null || r[c] === undefined) : r[c] === v));
          return q;
        },
        lt(c: string, v: any) { q._f.push((r: Row) => r[c] < v); return q; },
        lte(c: string, v: any) { q._f.push((r: Row) => (r[c] ?? 0) <= v); return q; },
        ilike(c: string, v: any) {
          const needle = String(v).replace(/%/g, '').toLowerCase();
          q._f.push((r: Row) => String(r[c] ?? '').toLowerCase().includes(needle));
          return q;
        },
        order(c: string, o?: any) { q._orderCol = c; q._desc = o?.ascending === false; return q; },
        limit(n: number) { q._limit = n; return q; },
        update(p: Row) { q._mode = 'update'; q._patch = p; return q; },
        insert(p: Row) { q._mode = 'insert'; q._insertPayload = p; return q; },
        _exec() {
          if (q._mode === 'insert') {
            const created = { id: `conv-${++idSeq}`, deleted_at: null, ...q._insertPayload };
            rows.push(created);
            return [created];
          }
          let matched = rows.filter((r) => q._f.every((f: any) => f(r)));
          if (q._mode === 'update') {
            for (const r of matched) Object.assign(r, q._patch);
          }
          if (q._orderCol) {
            const col = q._orderCol;
            matched = [...matched].sort((a, b) => {
              if (a[col] < b[col]) return q._desc ? 1 : -1;
              if (a[col] > b[col]) return q._desc ? -1 : 1;
              return 0;
            });
          }
          return matched.slice(0, q._limit);
        },
        maybeSingle: async () => ({ data: q._exec()[0] ?? null, error: null }),
        then(resolve: any) {
          return Promise.resolve({ data: q._exec(), error: null }).then(resolve);
        },
      };
      return q;
    },
  };
}

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
  requestStore: { run: (_store: any, fn: any) => fn() },
  enrichContext: vi.fn(),
  currentContext: () => undefined,
}));
vi.mock('./embeddings', () => ({ embedPassage: vi.fn(), embedQuery: vi.fn(), toPgVector: vi.fn() }));

const ACC = 'acct-1';
const OTHER_ACC = 'acct-2';

function seed(extra: Partial<Row>[] = []) {
  rows = [
    { id: 'conv-live', account_id: ACC, title: 'Live chat', transcript: [{ role: 'user', content: 'hi' }],
      token_estimate: 10, message_count: 1, updated_at: '2026-08-20T00:00:00.000Z', deleted_at: null },
    { id: 'conv-deleted', account_id: ACC, title: 'Deleted chat', transcript: [{ role: 'user', content: 'gone' }],
      token_estimate: 10, message_count: 1, updated_at: '2026-08-19T00:00:00.000Z',
      deleted_at: '2026-08-25T00:00:00.000Z' },
    { id: 'conv-foreign', account_id: OTHER_ACC, title: 'Not yours', transcript: [{ role: 'user', content: 'x' }],
      token_estimate: 10, message_count: 1, updated_at: '2026-08-18T00:00:00.000Z', deleted_at: null },
    ...extra,
  ];
  idSeq = 0;
}

beforeEach(() => { vi.resetModules(); seed(); });

describe('listConversationsForAccount excludes soft-deleted rows', () => {
  it('hides the deleted conversation from the list', async () => {
    const { listConversationsForAccount } = await import('@/lib/agent/memory');
    const page = await listConversationsForAccount(ACC, 30);
    const ids = page.conversations.map((c) => c.id);
    expect(ids).toContain('conv-live');
    expect(ids).not.toContain('conv-deleted');
  });
});

describe('loadConversation / loadTranscript exclude soft-deleted rows', () => {
  it('loadConversation returns null for a deleted conversation, same as unknown', async () => {
    const { loadConversation } = await import('@/lib/agent/memory');
    expect(await loadConversation('conv-deleted', ACC)).toBeNull();
    expect(await loadConversation('conv-unknown', ACC)).toBeNull();
  });

  it('loadTranscript reads empty for a deleted conversation', async () => {
    const { loadTranscript } = await import('@/lib/agent/memory');
    expect(await loadTranscript('conv-deleted', ACC)).toEqual([]);
  });

  it('still reads a live conversation normally', async () => {
    const { loadTranscript } = await import('@/lib/agent/memory');
    const msgs = await loadTranscript('conv-live', ACC);
    expect(msgs).toHaveLength(1);
  });
});

describe('deleteConversation — no existence oracle', () => {
  it('soft-deletes a conversation the caller owns', async () => {
    const { deleteConversation } = await import('@/lib/agent/memory');
    const ok = await deleteConversation(ACC, 'conv-live');
    expect(ok).toBe(true);
    expect(rows.find((r) => r.id === 'conv-live')!.deleted_at).toBeTruthy();
  });

  it('deleting an unknown id and deleting another account\'s id return the identical result', async () => {
    const { deleteConversation } = await import('@/lib/agent/memory');
    const unknown = await deleteConversation(ACC, 'conv-does-not-exist');
    const foreign = await deleteConversation(ACC, 'conv-foreign');
    expect(unknown).toBe(false);
    expect(foreign).toBe(false);
    expect(unknown).toBe(foreign);
    // And the foreign row is provably untouched — not just "reported false".
    expect(rows.find((r) => r.id === 'conv-foreign')!.deleted_at).toBeNull();
  });

  it('deleting an already-deleted conversation is also false, not an error', async () => {
    const { deleteConversation } = await import('@/lib/agent/memory');
    expect(await deleteConversation(ACC, 'conv-deleted')).toBe(false);
  });
});

describe('a deleted conversation is not resurrected by a late in-flight save', () => {
  it('refuses the write rather than writing through to the deleted row', async () => {
    const { saveConversation } = await import('@/lib/agent/memory');
    const result = await saveConversation({
      id: 'conv-deleted', accountId: ACC,
      transcript: [{ role: 'user', content: 'late reply' } as any],
    });
    expect(result).toBeNull();
    // The deleted row's content is untouched — the guard did not write through it.
    const stored = rows.find((r) => r.id === 'conv-deleted')!;
    expect(stored.transcript).toEqual([{ role: 'user', content: 'gone' }]);
    expect(stored.deleted_at).toBeTruthy();
  });

  it('does not fork a fresh conversation out of the deleted content either', async () => {
    const before = rows.length;
    const { saveConversation } = await import('@/lib/agent/memory');
    await saveConversation({
      id: 'conv-deleted', accountId: ACC,
      transcript: [{ role: 'user', content: 'late reply' } as any],
    });
    expect(rows.length).toBe(before);   // no insert happened
  });
});

// --- the migration itself -------------------------------------------------

const migrationPath = path.resolve(__dirname, '..', 'migrations', '069_conversation_deletion.sql');
const migrationText = fs.readFileSync(migrationPath, 'utf8');

describe('069_conversation_deletion.sql', () => {
  it('adds deleted_at to agent_conversations', () => {
    expect(migrationText).toMatch(/ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/);
  });

  it('indexes the not-deleted case', () => {
    expect(migrationText).toMatch(/CREATE INDEX IF NOT EXISTS idx_agent_conversations_live[\s\S]*WHERE deleted_at IS NULL/);
  });

  it('replaces purge_soft_deleted and still purges the original four tables', () => {
    expect(migrationText).toMatch(/CREATE OR REPLACE FUNCTION purge_soft_deleted/);
    for (const table of ['contacts', 'companies', 'deals', 'brands']) {
      const re = new RegExp(`DELETE FROM ${table}\\s+WHERE deleted_at IS NOT NULL AND deleted_at < cutoff`);
      expect(migrationText, `${table} DELETE missing or altered`).toMatch(re);
    }
  });

  it('purges agent_conversations past the same cutoff', () => {
    expect(migrationText).toMatch(/DELETE FROM agent_conversations\s+WHERE deleted_at IS NOT NULL AND deleted_at < cutoff/);
  });

  it('keeps the RETURNS INT row-count contract', () => {
    expect(migrationText).toMatch(/RETURNS INT AS \$\$/);
    expect(migrationText).toMatch(/RETURN n;/);
  });

  it('flags that the scheduler this depends on does not run yet', () => {
    // Not a fix — a note. /api/hermes/tick is the only caller of
    // purge_soft_deleted and has never executed successfully in production
    // (BACKLOG.md §2), so this migration alone does not make purging happen.
    expect(migrationText).toMatch(/hermes\/tick/);
    expect(migrationText.toLowerCase()).toMatch(/never executed successfully|no scheduler/);
  });
});

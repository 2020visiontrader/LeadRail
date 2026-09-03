// The test whose absence let a feature ship writing zero rows for its entire
// life. Drives the REAL extraction path — runMemoryExtraction /
// decideAndWrite / writeEdge / recordFact — against a fake multi-table
// supabase, with only the model call and the embedding provider mocked.
//
// THE DEFECT THIS PROVES FIXED: `decideAndWrite` wrote every accepted fact to
// the memory GRAPH (memory_edges / memory_subjects, migration 061) and never
// called `recordFact`, so `agent_memory` — the table `recallMemoryDigest` /
// `semanticRecall` / `listFacts` actually read from — stayed empty for the
// feature's entire life even though extraction ran on every conversation and
// the graph tables filled up. That is exactly the production signature this
// file reproduces: agent_conversations stamped, memory_edges non-empty,
// agent_memory zero — until the fix.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Record<string, any[]> = {};
let idSeq = 0;

/** Generic fluent fake, one array per table, modelled on the pattern already
 *  used in tests/plan-store-batch.test.ts and tests/memory-extract.test.ts.
 *  Extended to be MULTI-TABLE (keyed by name) because this test drives the
 *  full pipeline across agent_conversations, memory_edges, memory_subjects
 *  AND agent_memory in one run — no single existing fake covers all four. */
function makeClient() {
  function ensure(name: string) {
    if (!db[name]) db[name] = [];
    return db[name];
  }
  function table(name: string) {
    const rows = () => ensure(name);
    const q: any = {
      _f: [] as ((r: any) => boolean)[],
      _order: [] as { col: string; asc: boolean }[],
      _limit: Infinity,
      _mode: 'select',
      _patch: null as any,
      select() { return q; },
      eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
      is(c: string, v: any) { q._f.push((r: any) => (v === null ? (r[c] ?? null) === null : r[c] === v)); return q; },
      gte(c: string, v: any) { q._f.push((r: any) => (r[c] ?? 0) >= v); return q; },
      order(c: string, o?: { ascending?: boolean }) { q._order.push({ col: c, asc: o?.ascending !== false }); return q; },
      limit(n: number) { q._limit = n; return q; },
      insert(input: any) {
        const arr = Array.isArray(input) ? input : [input];
        const created = arr.map((r: any) => ({
          id: `id-${++idSeq}`, invalid_at: null, invalidated_by: null,
          occurrences: 1, source: 'extraction', ...r,
        }));
        rows().push(...created);
        const res = { data: created, error: null };
        return Object.assign(Promise.resolve(res), {
          select: () => Object.assign(Promise.resolve(res), {
            single: async () => ({ data: created[0], error: null }),
          }),
        });
      },
      update(p: any) { q._mode = 'update'; q._patch = p; return q; },
      delete() { q._mode = 'delete'; return q; },
      _run(): any[] {
        let r = rows().filter((row: any) => q._f.every((f: any) => f(row)));
        for (const o of [...q._order].reverse()) {
          r = r.slice().sort((a: any, b: any) => {
            const x = a[o.col], y = b[o.col];
            return x === y ? 0 : (x > y ? 1 : -1) * (o.asc ? 1 : -1);
          });
        }
        return r.slice(0, q._limit);
      },
      maybeSingle: async () => ({ data: q._run()[0] ?? null, error: null }),
      single: async () => ({ data: q._run()[0] ?? null, error: null }),
      then(resolve: any) {
        if (q._mode === 'update') {
          const matched = rows().filter((row: any) => q._f.every((f: any) => f(row)));
          for (const row of matched) Object.assign(row, q._patch);
          return resolve({ data: matched, error: null });
        }
        if (q._mode === 'delete') {
          const matched = rows().filter((row: any) => q._f.every((f: any) => f(row)));
          for (const row of matched) rows().splice(rows().indexOf(row), 1);
          return resolve({ data: matched, error: null });
        }
        return resolve({ data: q._run(), error: null });
      },
    };
    return q;
  }
  return { from: (t: string) => table(t), rpc: async () => ({ data: null, error: null }) };
}

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() } }));
vi.mock('@/lib/ai/router', () => ({ generateChat: vi.fn(), streamChat: vi.fn(), textConfigured: () => true }));
// Best-effort in the real module anyway (no NVIDIA_API_KEY in test env means
// embed() already short-circuits to null) — mocked explicitly so the test
// asserts against a controlled call count rather than "whatever env happens
// to be set".
vi.mock('@/lib/agent/embeddings', () => ({
  embedPassage: vi.fn(async () => null),
  embedQuery: vi.fn(async () => null),
  embedPassages: vi.fn(async () => null),
  toPgVector: (v: number[]) => `[${v.join(',')}]`,
}));

const ACC = 'acct-1';

/** A realistic transcript: the owner stating a durable venture decision, plus
 *  small talk that must NOT become a fact. */
const FIXTURE_TRANSCRIPT = [
  { role: 'user', content: 'hey, quick one before we start' },
  { role: 'assistant', content: 'Sure, go ahead.' },
  {
    role: 'user',
    content: "From now on Northwind only targets seed-stage B2B SaaS — we're dropping the enterprise segment entirely, it's not worth the sales cycle.",
  },
  { role: 'assistant', content: "Got it — I'll scope sourcing and campaigns to seed-stage B2B SaaS going forward and leave enterprise out." },
];

async function seedConversation(id: string) {
  db.agent_conversations = [{
    id,
    account_id: ACC,
    brand_id: null,
    transcript: FIXTURE_TRANSCRIPT,
    memory_extracted_at: null,
    updated_at: new Date().toISOString(),
  }];
}

beforeEach(() => {
  vi.resetModules();
  db = {};
  idSeq = 0;
});

describe('extraction actually writes durable memory (agent_memory)', () => {
  it('accepts a fact from a realistic transcript and writes it to agent_memory, not just the graph', async () => {
    await seedConversation('conv-1');
    const { generateChat } = await import('@/lib/ai/router') as any;
    (generateChat as any).mockResolvedValue(JSON.stringify({
      facts: [{
        subject_type: 'account',
        subject_label: 'this account',
        predicate: 'decided',
        object: 'seed-stage B2B SaaS only',
        fact: 'Northwind now only targets seed-stage B2B SaaS; enterprise is dropped entirely.',
      }],
    }));

    const { runMemoryExtraction } = await import('@/lib/memory/extract');
    const summary = await runMemoryExtraction(5);

    expect(summary.conversations).toBe(1);
    expect(summary.written).toBe(1);

    // The regression this test exists to catch: writeEdge succeeding (graph
    // non-empty) used to look identical to success from every counter and log
    // line this job emits, while agent_memory stayed silently empty.
    expect(db.memory_edges?.length).toBe(1);
    expect(db.agent_memory?.length).toBe(1);
    expect(db.agent_memory![0].account_id).toBe(ACC);
    expect(db.agent_memory![0].fact).toMatch(/seed-stage B2B SaaS/);

    // The conversation is stamped either way — extraction must not be
    // re-run just because this particular write path used to be silent.
    expect(db.agent_conversations[0].memory_extracted_at).toBeTruthy();
  });

  it('does not duplicate agent_memory rows for a fact restated across conversations (recurrence, not a second write)', async () => {
    await seedConversation('conv-1');
    const { generateChat } = await import('@/lib/ai/router') as any;
    const facts = JSON.stringify({
      facts: [{
        subject_type: 'account', subject_label: 'this account',
        predicate: 'decided', object: 'seed-stage B2B SaaS only',
        fact: 'Northwind now only targets seed-stage B2B SaaS.',
      }],
    });
    (generateChat as any).mockResolvedValue(facts);

    const { runMemoryExtraction } = await import('@/lib/memory/extract');
    await runMemoryExtraction(5);
    expect(db.agent_memory?.length).toBe(1);

    // A second conversation restating the identical fact.
    db.agent_conversations.push({
      id: 'conv-2', account_id: ACC, brand_id: null,
      transcript: FIXTURE_TRANSCRIPT, memory_extracted_at: null,
      updated_at: new Date().toISOString(),
    });
    const summary2 = await runMemoryExtraction(5);
    expect(summary2.recurrences).toBe(1);
    // Still one row — a recurrence is more evidence for the same fact, not a
    // second one.
    expect(db.agent_memory?.length).toBe(1);
  });

  it('never writes a fact containing a secret to agent_memory, even though extraction is the accepting path', async () => {
    await seedConversation('conv-1');
    const { generateChat } = await import('@/lib/ai/router') as any;
    (generateChat as any).mockResolvedValue(JSON.stringify({
      facts: [{
        subject_type: 'account', subject_label: 'this account',
        predicate: 'stated', object: 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789',
        fact: 'The API key is sk-live-abcdefghijklmnopqrstuvwxyz0123456789.',
      }],
    }));

    const { runMemoryExtraction } = await import('@/lib/memory/extract');
    const summary = await runMemoryExtraction(5);

    expect(summary.written).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(db.memory_edges?.length ?? 0).toBe(0);
    expect(db.agent_memory?.length ?? 0).toBe(0);
  });

  it('returns nothing (not a written fact) when the model has nothing durable to report', async () => {
    await seedConversation('conv-1');
    const { generateChat } = await import('@/lib/ai/router') as any;
    (generateChat as any).mockResolvedValue(JSON.stringify({ facts: [] }));

    const { runMemoryExtraction } = await import('@/lib/memory/extract');
    const summary = await runMemoryExtraction(5);

    expect(summary.written).toBe(0);
    expect(db.agent_memory?.length ?? 0).toBe(0);
    expect(db.agent_conversations[0].memory_extracted_at).toBeTruthy();
  });
});

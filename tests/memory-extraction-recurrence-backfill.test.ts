// THE PRODUCTION PROBE, reproduced exactly.
//
// The earlier fix for "agent_memory had zero rows for the feature's entire
// life" (see tests/memory-extraction-agent-memory.test.ts) gated the
// recordFact call on `res.outcome === 'written'` — a genuinely new graph
// edge — reasoning that recordFact's bare INSERT had no dedupe and would
// otherwise pile up duplicates for a fact restated many times.
//
// A production probe disproved that: a conversation already extracted once
// already has all its edges written to memory_edges. Reprocessing it (the
// only path that can backfill agent_memory for existing knowledge) can only
// ever produce `recurrence` outcomes from writeEdge — never `written` again.
// So agent_memory could NEVER be populated for anything the graph already
// knew: memory_edges stayed at 46/46, agent_memory stayed at 0.
//
// This test reproduces exactly that shape: memory_edges already holds the
// edge (as if extraction had run once under the old code), agent_memory is
// empty (the historical bug), and re-extracting the same conversation must
// still result in a fact landing in agent_memory even though writeEdge
// reports nothing but a recurrence.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Record<string, any[]> = {};
let idSeq = 0;

/** Same fake as tests/memory-extraction-agent-memory.test.ts — kept in sync
 *  deliberately rather than imported, so this file exercises the real modules
 *  against its own independent fake, per the "drive the real functions" rule. */
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
vi.mock('@/lib/agent/embeddings', () => ({
  embedPassage: vi.fn(async () => null),
  embedQuery: vi.fn(async () => null),
  embedPassages: vi.fn(async () => null),
  toPgVector: (v: number[]) => `[${v.join(',')}]`,
}));

const ACC = 'acct-1';

const FIXTURE_TRANSCRIPT = [
  { role: 'user', content: "From now on Northwind only targets seed-stage B2B SaaS — we're dropping the enterprise segment entirely." },
  { role: 'assistant', content: "Got it — scoping to seed-stage B2B SaaS going forward." },
];

const FACTS_RESPONSE = JSON.stringify({
  facts: [{
    subject_type: 'account',
    subject_label: 'this account',
    predicate: 'decided',
    object: 'seed-stage B2B SaaS only',
    fact: 'Northwind now only targets seed-stage B2B SaaS; enterprise is dropped entirely.',
  }],
});

beforeEach(() => {
  vi.resetModules();
  db = {};
  idSeq = 0;
});

describe('re-extracting an already-extracted conversation still converges agent_memory', () => {
  it('writes a fact to agent_memory from a RECURRENCE-only re-extraction (the production probe)', async () => {
    // Simulate the pre-fix production state: the graph edge already exists
    // (extraction ran once, under the old code), but agent_memory is empty —
    // exactly the "memory_edges 46, agent_memory 0" signature from the probe.
    db.agent_conversations = [{
      id: 'conv-1', account_id: ACC, brand_id: null,
      transcript: FIXTURE_TRANSCRIPT,
      memory_extracted_at: null, // cleared for reprocessing, as the probe did
      updated_at: new Date().toISOString(),
    }];
    db.memory_edges = [{
      id: 'edge-existing',
      account_id: ACC,
      subject_type: 'account',
      subject_id: ACC,
      predicate: 'decided',
      object: 'seed-stage B2B SaaS only',
      fact: 'Northwind now only targets seed-stage B2B SaaS; enterprise is dropped entirely.',
      tier: 1,
      occurrences: 1,
      invalid_at: null,
      invalidated_by: null,
      source: 'extraction',
      valid_from: new Date(Date.now() - 86400000).toISOString(),
      updated_at: new Date(Date.now() - 86400000).toISOString(),
      last_seen_at: new Date(Date.now() - 86400000).toISOString(),
    }];
    db.agent_memory = [];

    const { generateChat } = await import('@/lib/ai/router') as any;
    (generateChat as any).mockResolvedValue(FACTS_RESPONSE);

    const { runMemoryExtraction } = await import('@/lib/memory/extract');
    const summary = await runMemoryExtraction(5);

    // The regression signature: writeEdge reports a recurrence, not a write —
    // this is what made the old gate never fire on a backfill.
    expect(summary.written).toBe(0);
    expect(summary.recurrences).toBe(1);
    expect(db.memory_edges.length).toBe(1); // no new edge — still just the one
    expect((db.memory_edges[0] as any).occurrences).toBe(2); // bumped, per writeEdge

    // THE FIX: agent_memory must still end up non-empty.
    expect(db.agent_memory.length).toBe(1);
    expect(db.agent_memory[0].account_id).toBe(ACC);
    expect(db.agent_memory[0].fact).toMatch(/seed-stage B2B SaaS/);
  });
});

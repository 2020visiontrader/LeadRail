// recordFact used to be a bare INSERT with no dedupe — that absence was the
// stated reason the extractor gated its call on a genuinely NEW graph edge
// (see lib/memory/extract.ts / tests/memory-extraction-recurrence-backfill).
// That gate is gone now: recordFact itself must not accumulate duplicate rows
// when called repeatedly for the same fact, whether from a recurrence, a
// carryover re-ingestion, or a plain double-call.
//
// Drives the REAL recordFact against a fake supabase client (the module under
// test is not mocked) — pattern from tests/plan-store-batch.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: any[] = [];
let idSeq = 0;

function makeClient() {
  function table(name: string) {
    if (name !== 'agent_memory') {
      // Nothing else in this file touches another table.
      throw new Error(`unexpected table: ${name}`);
    }
    const q: any = {
      _f: [] as ((r: any) => boolean)[],
      _limit: Infinity,
      select() { return q; },
      eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
      limit(n: number) { q._limit = n; return q; },
      maybeSingle: async () => {
        const matched = rows.filter((r) => q._f.every((f: any) => f(r))).slice(0, q._limit);
        return { data: matched[0] ?? null, error: null };
      },
      insert(input: any) {
        const arr = Array.isArray(input) ? input : [input];
        const created = arr.map((r: any) => ({ id: `id-${++idSeq}`, ...r }));
        rows.push(...created);
        return Promise.resolve({ data: created, error: null });
      },
    };
    return q;
  }
  return { from: (t: string) => table(t) };
}

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() } }));
vi.mock('@/lib/agent/embeddings', () => ({
  embedPassage: vi.fn(async () => null),
  embedQuery: vi.fn(async () => null),
  embedPassages: vi.fn(async () => null),
  toPgVector: (v: number[]) => `[${v.join(',')}]`,
}));

const ACC = 'acct-1';

beforeEach(() => {
  vi.resetModules();
  rows = [];
  idSeq = 0;
});

describe('recordFact idempotency', () => {
  it('recording the same subject/predicate/object triple twice yields one row', async () => {
    const { recordFact } = await import('@/lib/agent/memory');
    const f = { fact: 'Northwind targets seed-stage B2B SaaS.', subject: 'Northwind', predicate: 'targets', object: 'seed-stage B2B SaaS' };
    await recordFact(ACC, f, 'extraction');
    await recordFact(ACC, f, 'extraction');
    const own = rows.filter((r) => r.account_id === ACC);
    expect(own.length).toBe(1);
  });

  it('recording the same fact TEXT twice (no triple) yields one row', async () => {
    const { recordFact } = await import('@/lib/agent/memory');
    const f = { fact: 'The team prefers async standups.' };
    await recordFact(ACC, f, 'carryover');
    await recordFact(ACC, f, 'carryover');
    expect(rows.length).toBe(1);
  });

  it('distinct facts still both write', async () => {
    const { recordFact } = await import('@/lib/agent/memory');
    await recordFact(ACC, { fact: 'Northwind targets seed-stage B2B SaaS.', subject: 'Northwind', predicate: 'targets', object: 'seed-stage B2B SaaS' }, 'extraction');
    await recordFact(ACC, { fact: 'Northwind avoids the enterprise segment.', subject: 'Northwind', predicate: 'avoids', object: 'enterprise segment' }, 'extraction');
    expect(rows.length).toBe(2);
  });

  it('a triple restated with different fact text still dedupes on the triple', async () => {
    const { recordFact } = await import('@/lib/agent/memory');
    await recordFact(ACC, { fact: 'Northwind targets seed-stage B2B SaaS.', subject: 'Northwind', predicate: 'targets', object: 'seed-stage B2B SaaS' }, 'extraction');
    await recordFact(ACC, { fact: 'Northwind only goes after seed-stage B2B SaaS companies.', subject: 'Northwind', predicate: 'targets', object: 'seed-stage B2B SaaS' }, 'extraction');
    expect(rows.length).toBe(1);
  });

  it('still rejects a credential-shaped fact', async () => {
    const { recordFact } = await import('@/lib/agent/memory');
    await recordFact(ACC, { fact: 'The API key is sk-live-abcdefghijklmnopqrstuvwxyz0123456789.' }, 'extraction');
    expect(rows.length).toBe(0);
  });
});

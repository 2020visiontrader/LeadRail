// decideAndWrite is where the calibration rules become behaviour. Testing the
// rules in isolation is not enough — that is precisely the gap that let the
// token-accounting bug survive a green suite for the whole life of the feature
// (reportOpenAIUsage was correct and unit-tested; nothing called it).
//
// So these drive the real decision function, with the real tier rules and the
// real writeEdge, against an in-memory table.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Row { [k: string]: any }
let table: Row[] = [];
let idSeq = 0;

function makeClient() {
  return {
    from(_t: string) {
      const q: any = {
        _filters: [] as ((r: Row) => boolean)[],
        _order: [] as { col: string; asc: boolean }[],
        _limit: Infinity,
        _mode: 'select', _patch: null as Row | null,
        select() { return q; },
        eq(c: string, v: any) { q._filters.push((r: Row) => r[c] === v); return q; },
        is(c: string, v: any) { q._filters.push((r: Row) => (v === null ? r[c] == null : r[c] === v)); return q; },
        gte(c: string, v: any) { q._filters.push((r: Row) => (r[c] ?? 0) >= v); return q; },
        order(c: string, o?: { ascending?: boolean }) { q._order.push({ col: c, asc: o?.ascending !== false }); return q; },
        limit(n: number) { q._limit = n; return q; },
        insert(rows: Row[]) {
          const created = rows.map((r) => ({
            id: `e-${++idSeq}`, invalid_at: null, invalidated_by: null,
            occurrences: 1, source: 'extraction', ...r,
          }));
          table.push(...created);
          return { select: () => ({ single: async () => ({ data: { id: created[0].id }, error: null }) }) };
        },
        update(p: Row) { q._mode = 'update'; q._patch = p; return q; },
        maybeSingle: async () => ({ data: q._run()[0] ?? null, error: null }),
        _run(): Row[] {
          let rows = table.filter((r) => q._filters.every((f: any) => f(r)));
          for (const o of [...q._order].reverse()) {
            rows = rows.slice().sort((a, b) => {
              const x = a[o.col], y = b[o.col];
              return x === y ? 0 : (x > y ? 1 : -1) * (o.asc ? 1 : -1);
            });
          }
          return rows.slice(0, q._limit);
        },
        then(resolve: any) {
          if (q._mode === 'update') {
            const rows = table.filter((r) => q._filters.every((f: any) => f(r)));
            for (const r of rows) Object.assign(r, q._patch);
            return resolve({ data: rows, error: null });
          }
          return resolve({ data: q._run(), error: null });
        },
      };
      return q;
    },
  };
}

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() } }));
vi.mock('@/lib/ai/router', () => ({ generateChat: vi.fn(), streamChat: vi.fn(), textConfigured: () => true }));

const ACC = 'acct-1';
const JANE = { type: 'contact' as const, id: 'jane' };

async function decide(fact: string, predicate = 'stated', object = '') {
  const { decideAndWrite } = await import('@/lib/memory/extract');
  return decideAndWrite(ACC, { subject: JANE, predicate, object: object || fact, fact }, 'conv-1');
}

describe('what gets written, and at which tier', () => {
  beforeEach(() => { table = []; idSeq = 0; });

  it('writes a stated commitment immediately, as tier 1', async () => {
    const d = await decide('Agreed to a pilot starting in October.', 'committed_to', 'pilot in October');
    expect(d.outcome).toBe('written');
    expect(d.tier).toBe(1);
    expect(table[0].tier).toBe(1);
  });

  it('writes an observation as tier 2, not tier 1', async () => {
    const d = await decide('Seems to reply faster to email.', 'prefers_channel', 'email');
    expect(d.outcome).toBe('written');
    expect(d.tier).toBe(2);
  });

  it('stamps every written fact with its source conversation', async () => {
    // No orphaned facts: an assertion that cannot be traced to where it came
    // from should not have been written.
    await decide('Budget is $65k.', 'has_budget', '$65k');
    expect(table[0].conversation_id).toBe('conv-1');
  });
});

describe('what never gets written', () => {
  beforeEach(() => { table = []; idSeq = 0; });

  it('discards an inferred causal narrative entirely — no row, not a flagged row', async () => {
    // The compounding failure: an invented cause becomes a premise for every
    // later decision. It must not exist as an edge nobody happens to read.
    const d = await decide('The campaign underperformed because the audience is fatigued.', 'campaign_outcome');
    expect(d.outcome).toBe('skipped');
    expect(d.rule).toBe('excluded:invented-causation');
    expect(table).toHaveLength(0);
  });

  it("discards a read on the contact's psychology", async () => {
    const d = await decide('Jane seems hesitant about the renewal.', 'sentiment');
    expect(d.outcome).toBe('skipped');
    expect(table).toHaveLength(0);
  });

  it('discards compliance-excluded content even when the fact reads innocuously', async () => {
    const d = await decide('Noted their details.', 'has_reference', 'SSN 123-45-6789');
    expect(d.outcome).toBe('skipped');
    expect(table).toHaveLength(0);
  });

  it('names the rule that fired, so the threshold can be tuned from real data', async () => {
    const d = await decide('Probably just tire-kicking.', 'sentiment');
    expect(d.rule).toMatch(/^excluded:/);
  });

  it('discards an over-long blob rather than truncating it into memory', async () => {
    const d = await decide('x'.repeat(600));
    expect(d.outcome).toBe('skipped');
    expect(d.rule).toBe('too-long');
  });
});

describe('the decision is reported whatever it was', () => {
  beforeEach(() => { table = []; idSeq = 0; });

  it('reports a recurrence distinctly from a first write', async () => {
    const first = await decide('Prefers email.', 'prefers_channel', 'email');
    const second = await decide('Prefers email.', 'prefers_channel', 'email');
    expect(first.outcome).toBe('written');
    expect(second.outcome).toBe('recurrence');
    expect(table).toHaveLength(1);
  });

  it('reports a supersession with the edge it replaced', async () => {
    await decide('Budget is $40k.', 'has_budget', '$40k');
    const d = await decide('Budget is now $65k.', 'has_budget', '$65k');
    expect(d.outcome).toBe('written');
    expect(d.supersededEdgeId).toBeTruthy();
  });
});

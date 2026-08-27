// The bitemporal invariant: an edge is invalidated, never overwritten, never
// deleted. That is what makes "what did we believe on 1 August" answerable —
// and for a system that spends money autonomously, it is what makes an action
// auditable after the fact.
//
// These drive the real writeEdge against an in-memory stand-in for the Supabase
// client, so the contradiction/recurrence/precedence logic under test is the
// shipped logic, not a restatement of it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Row { [k: string]: any }
let table: Row[] = [];
let idSeq = 0;

/** Minimal PostgREST-shaped fake: enough of .select/.eq/.is/.order/.limit,
 *  .insert().select().single(), and .update().eq() for these paths. */
function makeClient() {
  return {
    from(_t: string) {
      const q: any = {
        _filters: [] as ((r: Row) => boolean)[],
        _order: [] as { col: string; asc: boolean }[],
        _limit: Infinity,
        _mode: 'select' as 'select' | 'update',
        _patch: null as Row | null,
        select() { return q; },
        eq(col: string, val: any) { q._filters.push((r: Row) => r[col] === val); return q; },
        is(col: string, val: any) { q._filters.push((r: Row) => (val === null ? r[col] == null : r[col] === val)); return q; },
        gte(col: string, val: any) { q._filters.push((r: Row) => (r[col] ?? 0) >= val); return q; },
        order(col: string, o?: { ascending?: boolean }) { q._order.push({ col, asc: o?.ascending !== false }); return q; },
        limit(n: number) { q._limit = n; return q; },
        insert(rows: Row[]) {
          const created = rows.map((r) => ({
            id: `edge-${++idSeq}`, invalid_at: null, invalidated_by: null,
            occurrences: 1, source: 'extraction', ...r,
          }));
          table.push(...created);
          return {
            select: () => ({
              single: async () => ({ data: { id: created[0].id }, error: null }),
            }),
          };
        },
        update(patch: Row) { q._mode = 'update'; q._patch = patch; return q; },
        maybeSingle: async () => {
          const rows = q._run();
          return { data: rows[0] ?? null, error: null };
        },
        _run(): Row[] {
          let rows = table.filter((r) => q._filters.every((f: any) => f(r)));
          for (const o of [...q._order].reverse()) {
            rows = rows.slice().sort((a, b) => {
              const x = a[o.col], y = b[o.col];
              if (x === y) return 0;
              return (x > y ? 1 : -1) * (o.asc ? 1 : -1);
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
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));

const ACC = 'acct-1';
const JANE = { type: 'contact' as const, id: 'jane' };

async function write(overrides: Record<string, any> = {}) {
  const { writeEdge } = await import('@/lib/memory/edges');
  return writeEdge({
    accountId: ACC, subject: JANE,
    predicate: 'has_budget', object: '$40k',
    fact: 'Budget is $40k.', tier: 1,
    ...overrides,
  });
}

describe('contradiction invalidates, never overwrites', () => {
  beforeEach(() => { table = []; idSeq = 0; });

  it('supersedes an existing value and keeps BOTH rows', async () => {
    await write({ object: '$40k', fact: 'Budget is $40k.' });
    const second = await write({ object: '$65k', fact: 'Budget is now $65k.' });

    expect(second.outcome).toBe('written');
    expect(second.supersededEdgeId).toBeTruthy();

    // The negotiation history is the whole point: two rows, not one updated.
    expect(table).toHaveLength(2);
    const old = table.find((r) => r.object === '$40k')!;
    const now = table.find((r) => r.object === '$65k')!;
    expect(old.invalid_at).toBeTruthy();
    expect(old.invalidated_by).toBe(now.id);
    expect(now.invalid_at).toBeNull();
  });

  it('leaves exactly one active edge per predicate after a contradiction', async () => {
    await write({ object: '$40k' });
    await write({ object: '$65k' });
    await write({ object: '$80k' });
    const active = table.filter((r) => r.invalid_at == null);
    expect(active).toHaveLength(1);
    expect(active[0].object).toBe('$80k');
    expect(table).toHaveLength(3); // nothing deleted
  });

  it('makes the full belief history readable, newest first', async () => {
    // Explicit validFrom: this asserts TEMPORAL ordering, and two writes in the
    // same millisecond have no temporal order to assert. In production these
    // are separate extraction passes minutes or days apart.
    await write({ object: '$40k', fact: 'Budget is $40k.', validFrom: '2026-07-15T00:00:00.000Z' });
    await write({ object: '$65k', fact: 'Budget is now $65k.', validFrom: '2026-08-20T00:00:00.000Z' });
    const { beliefHistory } = await import('@/lib/memory/edges');
    const history = await beliefHistory(ACC, JANE, 'has_budget');
    expect(history.map((h) => h.object)).toEqual(['$65k', '$40k']);
    expect(history[1].invalidAt).toBeTruthy();
    // The window each value was true for is what makes "what did we believe on
    // 1 August" answerable.
    expect(history[1].validFrom).toBe('2026-07-15T00:00:00.000Z');
    expect(history[0].validFrom).toBe('2026-08-20T00:00:00.000Z');
  });
});

describe('repetition is evidence, not a new fact', () => {
  beforeEach(() => { table = []; idSeq = 0; });

  it('bumps occurrences instead of inserting a duplicate', async () => {
    await write({ predicate: 'prefers_channel', object: 'email', fact: 'Prefers email.', tier: 2 });
    const again = await write({ predicate: 'prefers_channel', object: 'email', fact: 'Prefers email.', tier: 2 });

    expect(again.outcome).toBe('recurrence');
    expect(again.occurrences).toBe(2);
    expect(table).toHaveLength(1);
  });

  it('is case- and whitespace-insensitive about what counts as the same claim', async () => {
    await write({ predicate: 'prefers_channel', object: 'Email', tier: 2 });
    const again = await write({ predicate: 'prefers_channel', object: '  email ', tier: 2 });
    expect(again.outcome).toBe('recurrence');
    expect(table).toHaveLength(1);
  });

  it('only surfaces a pattern for review once it clears the threshold', async () => {
    const { promotionCandidates } = await import('@/lib/memory/edges');
    await write({ predicate: 'observed_pattern', object: 'short subjects', tier: 2 });
    expect(await promotionCandidates(ACC, 3)).toHaveLength(0);

    await write({ predicate: 'observed_pattern', object: 'short subjects', tier: 2 });
    await write({ predicate: 'observed_pattern', object: 'short subjects', tier: 2 });
    const ready = await promotionCandidates(ACC, 3);
    expect(ready).toHaveLength(1);
    expect(ready[0].occurrences).toBe(3);
  });

  it('never surfaces a tier 1 fact as a promotion candidate — it is already established', async () => {
    const { promotionCandidates } = await import('@/lib/memory/edges');
    await write({ predicate: 'has_role', object: 'VP', tier: 1 });
    await write({ predicate: 'has_role', object: 'VP', tier: 1 });
    await write({ predicate: 'has_role', object: 'VP', tier: 1 });
    expect(await promotionCandidates(ACC, 3)).toHaveLength(0);
  });
});

describe('declared context outranks inference', () => {
  beforeEach(() => { table = []; idSeq = 0; });

  it('refuses to let extraction supersede a user-declared fact', async () => {
    await write({
      predicate: 'brand_voice_rule', object: 'no exclamation points',
      fact: 'Never use exclamation points.', source: 'declared',
    });
    const inferred = await write({
      predicate: 'brand_voice_rule', object: 'exclamation points are fine',
      fact: 'Exclamation points seem fine.', source: 'extraction',
    });

    expect(inferred.outcome).toBe('unchanged');
    expect(table).toHaveLength(1);
    expect(table[0].object).toBe('no exclamation points');
    expect(table[0].invalid_at).toBeNull();
  });

  it('still lets the PERSON change what they declared', async () => {
    await write({ predicate: 'brand_voice_rule', object: 'no exclamations', source: 'declared' });
    const revised = await write({ predicate: 'brand_voice_rule', object: 'exclamations allowed', source: 'declared' });
    expect(revised.outcome).toBe('written');
    const active = table.filter((r) => r.invalid_at == null);
    expect(active).toHaveLength(1);
    expect(active[0].object).toBe('exclamations allowed');
  });
});

describe('active reads', () => {
  beforeEach(() => { table = []; idSeq = 0; });

  it('excludes invalidated edges', async () => {
    const { activeEdges } = await import('@/lib/memory/edges');
    await write({ object: '$40k' });
    await write({ object: '$65k' });
    const active = await activeEdges(ACC, JANE);
    expect(active).toHaveLength(1);
    expect(active[0].object).toBe('$65k');
  });

  it('scopes to the account — another tenant never leaks in', async () => {
    const { activeEdges } = await import('@/lib/memory/edges');
    await write({ object: '$40k' });
    await write({ accountId: 'other-account', object: '$999k' } as any);
    const active = await activeEdges(ACC, JANE);
    expect(active).toHaveLength(1);
    expect(active[0].object).toBe('$40k');
  });
});

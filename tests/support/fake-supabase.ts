// A deliberately small in-memory stand-in for the Supabase query builder.
//
// The approval gate is the load-bearing piece of the platform's safety model,
// and until now nothing tested its BEHAVIOUR — the 31 existing tests assert
// over static registry metadata and never execute anything. The obstacle was
// always that the store talks to Postgres, so testing it seemed to require a
// live database, and a live database means shared state, network flake, and
// tests that cannot assert on a race.
//
// This removes that obstacle. It models only what lib/approvals/store.ts
// actually uses, and it models the ONE property the gate depends on for
// correctness: a state-conditioned UPDATE matches zero rows when the state has
// already moved. That is what makes an approval single-use, and it is exactly
// what a test needs to be able to drive deterministically.
//
// NOT a Postgres emulator. It has no types, no constraints, no RLS. It proves
// the store's logic, not the schema — schema correctness is the migration's
// job.

export interface FakeTable { rows: Record<string, any>[] }

type Filter = [string, any];

class Query implements PromiseLike<{ data: any; error: any }> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: any = null;
  private rowMode: 'one' | 'maybe' | null = null;
  private orderBy: { col: string; asc: boolean }[] = [];

  constructor(private table: FakeTable, private onWrite?: () => void) {}

  select(_cols?: string) { if (this.op === 'select') this.op = 'select'; return this; }
  insert(rows: any) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch: any) { this.op = 'update'; this.payload = patch; return this; }
  eq(col: string, val: any) { this.filters.push([col, val]); return this; }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy.push({ col, asc: opts?.ascending !== false }); return this;
  }
  limit(_n: number) { return this; }
  maybeSingle() { this.rowMode = 'maybe'; return this; }
  single() { this.rowMode = 'one'; return this; }

  private matches(row: any) { return this.filters.every(([c, v]) => row[c] === v); }

  private run(): { data: any; error: any } {
    let out: any[];
    if (this.op === 'insert') {
      const now = new Date().toISOString();
      out = this.payload.map((r: any) => ({
        id: r.id ?? `ap_${Math.random().toString(36).slice(2, 11)}`,
        created_at: now, updated_at: now,
        args_encrypted: null, decided_by: null, decided_at: null, comment: null,
        expires_at: null, conversation_id: null, requested_by: null,
        ...r,
      }));
      this.table.rows.push(...out);
      this.onWrite?.();
    } else if (this.op === 'update') {
      // The single-use guard lives HERE: rows are selected under the filters
      // that were chained on, so a .eq('state','approved') that no longer holds
      // matches nothing and the caller sees zero rows — the same signal real
      // Postgres gives, and the reason two racing consumers cannot both win.
      out = this.table.rows.filter((r) => this.matches(r));
      for (const r of out) Object.assign(r, this.payload);
      this.onWrite?.();
    } else {
      out = this.table.rows.filter((r) => this.matches(r));
      for (const o of [...this.orderBy].reverse()) {
        out.sort((a, b) => (a[o.col] > b[o.col] ? 1 : a[o.col] < b[o.col] ? -1 : 0) * (o.asc ? 1 : -1));
      }
    }
    out = out.map((r) => ({ ...r })); // callers must not hold a live reference
    if (this.rowMode === 'one') {
      if (out.length !== 1) return { data: null, error: { message: 'expected exactly one row' } };
      return { data: out[0], error: null };
    }
    if (this.rowMode === 'maybe') return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }

  then<A, B>(res?: ((v: { data: any; error: any }) => A | PromiseLike<A>) | null,
             rej?: ((r: any) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(res, rej);
  }
}

export function makeFakeSupabase() {
  const tables: Record<string, FakeTable> = {};
  const table = (n: string) => (tables[n] ??= { rows: [] });
  return {
    client: { from: (n: string) => new Query(table(n)) },
    tableRows: (n: string) => table(n).rows,
    reset: () => { for (const k of Object.keys(tables)) delete tables[k]; },
  };
}

/** Shared instance. The vi.mock factory and the test body must observe the SAME
 *  object — vi.mock is hoisted above imports and cannot close over a local, so
 *  both sides reach it through this module's (cached) instance instead. */
export const db = makeFakeSupabase();

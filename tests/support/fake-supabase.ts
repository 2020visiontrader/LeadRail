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

/** Column defaults the real schema supplies on INSERT.
 *
 *  Without these the fake silently under-reports a row: `status` and
 *  `progress_log` have DB defaults, so code that reads them straight back from
 *  an insert works in Postgres and returns undefined here. That makes a correct
 *  capability look broken — the fake must not be more permissive OR more
 *  forgetful than the thing it stands in for.
 *
 *  Declared per table, so one table's columns never leak into another's rows. */
const TABLE_DEFAULTS: Record<string, () => Record<string, any>> = {
  approvals: () => ({
    args_encrypted: null, decided_by: null, decided_at: null, comment: null,
    expires_at: null, conversation_id: null, requested_by: null,
  }),
  brand_goals: () => ({
    status: 'active', progress_log: [], last_worked_at: null, met_at: null,
  }),
};

type Filter = [string, any];

/** Predicate a test can install to make one class of query fail.
 *
 *  Needed because "the query errored" and "the query returned zero rows" are
 *  different facts that a caller must render differently, and a fake that can
 *  only ever succeed cannot prove the difference is handled. */
export type FailWhen = (info: { table: string; head: boolean }) => { message: string } | null;

class Query implements PromiseLike<{ data: any; error: any }> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: any = null;
  private rowMode: 'one' | 'maybe' | null = null;
  private orderBy: { col: string; asc: boolean }[] = [];
  // One .or(...) call's clauses, ANDed with `filters` but OR'd against each
  // other — models PostgREST's `.or('a.eq.1,b.is.null')`. Only `eq` and
  // `is.null` are parsed because that is the entire vocabulary the account-id
  // scoping filter (lib/support/tickets.ts and its siblings) actually uses;
  // anything else is a bug in the caller, not something to silently accept.
  private orFilters: { col: string; op: string; val: string }[] | null = null;
  // `select(cols, { count: 'exact', head: true })` — PostgREST's row count.
  // head means "no rows, just the number", and the number is NOT capped by
  // .limit(): that is the whole reason app/api/logs/route.ts counts this way.
  private countMode = false;
  private headOnly = false;
  private rowLimit: number | null = null;
  private ranges: { col: string; op: 'gte' | 'lte'; val: any }[] = [];
  private likes: { col: string; needle: string }[] = [];

  constructor(
    private table: FakeTable,
    private tableName: string,
    private onWrite?: () => void,
    private failWhen?: () => FailWhen | null,
  ) {}

  select(_cols?: string, opts?: { count?: 'exact'; head?: boolean }) {
    if (this.op === 'select') this.op = 'select';
    if (opts?.count) this.countMode = true;
    if (opts?.head) this.headOnly = true;
    return this;
  }
  insert(rows: any) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch: any) { this.op = 'update'; this.payload = patch; return this; }
  eq(col: string, val: any) { this.filters.push([col, val]); return this; }
  or(filterStr: string) {
    this.orFilters = filterStr.split(',').map((clause) => {
      const [col, op, ...rest] = clause.split('.');
      return { col, op, val: rest.join('.') };
    });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy.push({ col, asc: opts?.ascending !== false }); return this;
  }
  gte(col: string, val: any) { this.ranges.push({ col, op: 'gte', val }); return this; }
  lte(col: string, val: any) { this.ranges.push({ col, op: 'lte', val }); return this; }
  ilike(col: string, pattern: string) {
    this.likes.push({ col, needle: pattern.replace(/^%|%$/g, '').toLowerCase() });
    return this;
  }
  // Honours the limit for real. A no-op here would make a test that exists to
  // prove a count ISN'T capped by the limit pass without the fix.
  limit(n: number) { this.rowLimit = n; return this; }
  maybeSingle() { this.rowMode = 'maybe'; return this; }
  single() { this.rowMode = 'one'; return this; }

  private matches(row: any) {
    if (!this.filters.every(([c, v]) => row[c] === v)) return false;
    if (!this.ranges.every(({ col, op, val }) => (op === 'gte' ? row[col] >= val : row[col] <= val))) return false;
    if (!this.likes.every(({ col, needle }) => String(row[col] ?? '').toLowerCase().includes(needle))) return false;
    if (!this.orFilters) return true;
    return this.orFilters.some(({ col, op, val }) => {
      if (op === 'is') return val === 'null' ? row[col] === null || row[col] === undefined : row[col] === val;
      return row[col] === val; // 'eq' — string comparison, matching how ids/account ids are compared here
    });
  }

  private run(): { data: any; error: any; count?: number | null } {
    const failure = this.failWhen?.()?.({ table: this.tableName, head: this.headOnly });
    if (failure) return { data: null, error: failure, count: null };
    let out: any[];
    if (this.op === 'insert') {
      const now = new Date().toISOString();
      const defaults = TABLE_DEFAULTS[this.tableName]?.() ?? {};
      out = this.payload.map((r: any) => ({
        id: r.id ?? `row_${Math.random().toString(36).slice(2, 11)}`,
        created_at: now, updated_at: now,
        ...defaults,
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
      if (this.countMode) {
        // The count is taken BEFORE the limit, exactly as PostgREST does.
        const total = out.length;
        return { data: this.headOnly ? null : out.slice(0, this.rowLimit ?? out.length), error: null, count: total };
      }
      if (this.rowLimit !== null) out = out.slice(0, this.rowLimit);
    }
    out = out.map((r) => ({ ...r })); // callers must not hold a live reference
    if (this.rowMode === 'one') {
      if (out.length !== 1) return { data: null, error: { message: 'expected exactly one row' } };
      return { data: out[0], error: null };
    }
    if (this.rowMode === 'maybe') return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }

  then<A, B>(res?: ((v: { data: any; error: any; count?: number | null }) => A | PromiseLike<A>) | null,
             rej?: ((r: any) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(res, rej);
  }
}

export function makeFakeSupabase() {
  const tables: Record<string, FakeTable> = {};
  let failWhen: FailWhen | null = null;
  const table = (n: string) => (tables[n] ??= { rows: [] });
  return {
    client: { from: (n: string) => new Query(table(n), n, undefined, () => failWhen) },
    tableRows: (n: string) => table(n).rows,
    /** Install (or clear, with null) a per-query failure predicate. */
    setFailWhen: (fn: FailWhen | null) => { failWhen = fn; },
    reset: () => { for (const k of Object.keys(tables)) delete tables[k]; failWhen = null; },
  };
}

/** Shared instance. The vi.mock factory and the test body must observe the SAME
 *  object — vi.mock is hoisted above imports and cannot close over a local, so
 *  both sides reach it through this module's (cached) instance instead. */
export const db = makeFakeSupabase();

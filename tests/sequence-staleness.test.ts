// BACKLOG.md #3: processDueEnrollments selected due enrollments with
// `.lte('next_run_at', now)` and no lower bound. Safe only because
// sequence_enrollments was empty — the moment a contact is enrolled and the
// tick's first run is late (it has never once succeeded in production, see
// BACKLOG.md #2), a step that came due days ago would fire as if it were
// current: a month-stale marketing email landing out of nowhere in a real
// inbox.
//
// These pin the staleness floor both directions, since a sign error here
// inverts the fix silently: either everything gets paused (nothing ever
// sends) or nothing gets paused (the defect ships unguarded).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Generic PostgREST-shaped fake, keyed by table name. Chain methods filter
// in-memory; `then()` (or an explicit terminal call) executes the query.
// Mirrors the style of tests/conversation-list.test.ts, generalized to the
// several tables processDueEnrollments touches.
// ---------------------------------------------------------------------------
let db: Record<string, any[]>;
let rpcImpl: Record<string, (params: any) => any>;
let rpcCalls: { name: string; params: any }[];

function resetDb() {
  db = {
    sequence_enrollments: [],
    inbox_messages: [],
    contacts: [],
    accounts: [],
    sequences: [],
    message_templates: [],
  };
  rpcCalls = [];
  rpcImpl = {
    // Default: RPC absent (migration not applied) → forces the fallback
    // plain-select path. Individual tests override this to exercise the
    // atomic-claim path instead.
    claim_due_enrollments: () => ({ data: null, error: { message: 'function does not exist' } }),
    account_sent_today: () => ({ data: 0, error: null }),
    increment_step_counter: () => ({ data: null, error: null }),
    increment_variant_counter: () => ({ data: null, error: null }),
  };
}

function makeQuery(table: string) {
  const filters: ((r: any) => boolean)[] = [];
  let limitN = Infinity;
  let orderCol: string | null = null;
  let orderAsc = true;
  let single = false;
  let maybeSingle = false;
  let op: 'select' | 'update' | 'insert' | 'upsert' | 'delete' = 'select';
  let payload: any = null;

  const q: any = {
    select() { return q; },
    eq(c: string, v: any) { filters.push((r) => r[c] === v); return q; },
    lte(c: string, v: any) { filters.push((r) => r[c] <= v); return q; },
    gte(c: string, v: any) { filters.push((r) => r[c] >= v); return q; },
    in(c: string, arr: any[]) { filters.push((r) => arr.includes(r[c])); return q; },
    is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
    order(c: string, o?: any) { orderCol = c; orderAsc = o?.ascending !== false; return q; },
    limit(n: number) { limitN = n; return q; },
    single() { single = true; return q; },
    maybeSingle() { maybeSingle = true; return q; },
    update(data: any) { op = 'update'; payload = data; return q; },
    insert(data: any) { op = 'insert'; payload = data; return q; },
    upsert(data: any) { op = 'upsert'; payload = data; return q; },
    delete() { op = 'delete'; return q; },
    then(resolve: any, reject?: any) {
      return Promise.resolve(execute()).then(resolve, reject);
    },
  };

  function execute() {
    const rows: any[] = db[table] || (db[table] = []);
    if (op === 'select') {
      let out = rows.filter((r) => filters.every((f) => f(r)));
      if (orderCol) {
        const col = orderCol;
        out = [...out].sort((a, b) => {
          if (a[col] < b[col]) return orderAsc ? -1 : 1;
          if (a[col] > b[col]) return orderAsc ? 1 : -1;
          return 0;
        });
      }
      out = out.slice(0, limitN);
      if (single) return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'not found' } };
      if (maybeSingle) return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    }
    if (op === 'update') {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      for (const r of matched) Object.assign(r, payload);
      return { data: matched, error: null };
    }
    if (op === 'insert' || op === 'upsert') {
      const toInsert = Array.isArray(payload) ? payload : [payload];
      rows.push(...toInsert);
      return { data: toInsert, error: null };
    }
    if (op === 'delete') {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      db[table] = rows.filter((r) => !matched.includes(r));
      return { data: matched, error: null };
    }
    return { data: null, error: null };
  }

  return q;
}

vi.mock('@/lib/db', () => ({
  supabase: {
    from(table: string) { return makeQuery(table); },
    rpc(name: string, params: any) {
      rpcCalls.push({ name, params });
      const fn = rpcImpl[name];
      const result = fn ? fn(params) : { data: null, error: { message: `no rpc mock for ${name}` } };
      return Promise.resolve(result);
    },
  },
  dbReady: () => true,
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));

const sentEmails: any[] = [];
vi.mock('@/lib/outreach', () => ({
  SuppressedError: class SuppressedError extends Error {},
  sendOutreachEmail: vi.fn(async (req: any) => { sentEmails.push(req); return { id: 'msg-' + req.contactId }; }),
}));

vi.mock('@/lib/crm', () => ({
  createActivity: vi.fn(async () => ({})),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const HOUR = 3600 * 1000;

function seedSequence(overrides: Record<string, any> = {}) {
  db.sequences.push({
    id: 'seq1',
    brand_id: 'brand1',
    is_active: true,
    business_hours: null, // 24/7, and account_id is absent so resolveBusinessHours short-circuits
    sequence_steps: [
      {
        id: 'step0',
        step_order: 0,
        type: 'email',
        delay_hours: 0,
        subject: 'Hi there',
        body: 'Body copy',
        template_id: null,
        sequence_step_variants: [],
      },
    ],
    ...overrides,
  });
}

function seedContactAndAccount() {
  db.contacts.push({ id: 'c1', account_id: 'acct1' });
  db.accounts.push({ id: 'acct1', daily_send_cap: 500 });
}

function seedEnrollment(overrides: Record<string, any> = {}) {
  const enr = {
    id: 'enr1',
    sequence_id: 'seq1',
    contact_id: 'c1',
    current_step: 0,
    status: 'active',
    next_run_at: new Date().toISOString(),
    last_event: null,
    claim_id: null,
    locked_until: null,
    ...overrides,
  };
  db.sequence_enrollments.push(enr);
  return enr;
}

/** Make claim_due_enrollments succeed and hand back exactly `rows` (RPC path). */
function useRpcPath(rows: any[]) {
  rpcImpl.claim_due_enrollments = () => ({ data: rows, error: null });
}

async function run(limit = 25) {
  const { processDueEnrollments } = await import('@/lib/sequences');
  return processDueEnrollments(limit);
}

describe('sequence staleness floor', () => {
  beforeEach(() => {
    vi.resetModules();
    resetDb();
    sentEmails.length = 0;
    delete process.env.SEQUENCE_STALE_HOURS;
  });
  afterEach(() => {
    delete process.env.SEQUENCE_STALE_HOURS;
  });

  it('does NOT send an enrollment 26 days overdue, and pauses it with a reason (fallback path)', async () => {
    seedSequence();
    seedContactAndAccount();
    const enr = seedEnrollment({ next_run_at: new Date(Date.now() - 26 * 24 * HOUR).toISOString() });

    const result = await run();

    expect(sentEmails).toHaveLength(0);
    const row = db.sequence_enrollments.find((r) => r.id === enr.id);
    expect(row.status).toBe('paused');
    expect(row.last_event).toMatch(/stale/i);
    expect(row.last_event).toMatch(/\d+h/); // records how overdue it was
    expect(result.stale).toBe(1);
    expect(result.processed).toBe(0);
  });

  it('sends an enrollment that came due 5 minutes ago (ordinary operation is not broken)', async () => {
    seedSequence();
    seedContactAndAccount();
    const enr = seedEnrollment({ next_run_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() });

    const result = await run();

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].contactId).toBe('c1');
    const row = db.sequence_enrollments.find((r) => r.id === enr.id);
    // The fixture sequence has exactly one step, so a normal send completes it
    // — the point being it is NOT 'paused', i.e. the floor left it alone.
    expect(row.status).toBe('completed');
    expect(row.last_event).toBe('sent');
    expect(result.processed).toBe(1);
    expect(result.stale).toBe(0);
  });

  it('boundary: just inside the default 48h floor sends, just outside pauses', async () => {
    seedSequence();
    seedContactAndAccount();
    db.accounts[0].id = 'acct1';
    // Two independent contacts so both rows can be processed in one tick.
    db.contacts.push({ id: 'c2', account_id: 'acct1' });

    const justInside = seedEnrollment({
      id: 'enr-inside',
      contact_id: 'c1',
      next_run_at: new Date(Date.now() - (48 * HOUR - 60_000)).toISOString(), // 1 min shy of the floor
    });
    const justOutside = seedEnrollment({
      id: 'enr-outside',
      contact_id: 'c2',
      next_run_at: new Date(Date.now() - (48 * HOUR + 60_000)).toISOString(), // 1 min past the floor
    });

    const result = await run();

    const inside = db.sequence_enrollments.find((r) => r.id === justInside.id);
    const outside = db.sequence_enrollments.find((r) => r.id === justOutside.id);
    // One-step fixture sequence: a normal send completes it, not 'paused'.
    expect(inside.status).toBe('completed');
    expect(inside.last_event).toBe('sent');
    expect(outside.status).toBe('paused');
    expect(outside.last_event).toMatch(/stale/i);
    expect(result.processed).toBe(1);
    expect(result.stale).toBe(1);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].contactId).toBe('c1');
  });

  it('honours SEQUENCE_STALE_HOURS instead of the 48h default', async () => {
    process.env.SEQUENCE_STALE_HOURS = '1';
    seedSequence();
    seedContactAndAccount();
    // 2 hours overdue: fine under the 48h default, stale under a 1h floor.
    const enr = seedEnrollment({ next_run_at: new Date(Date.now() - 2 * HOUR).toISOString() });

    const result = await run();

    expect(sentEmails).toHaveLength(0);
    const row = db.sequence_enrollments.find((r) => r.id === enr.id);
    expect(row.status).toBe('paused');
    expect(row.last_event).toMatch(/floor 1h/);
    expect(result.stale).toBe(1);
  });

  it('counts a paused-as-stale enrollment separately from a processed one', async () => {
    seedSequence();
    seedContactAndAccount();
    db.contacts.push({ id: 'c2', account_id: 'acct1' });
    seedEnrollment({
      id: 'enr-fresh',
      contact_id: 'c1',
      next_run_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    seedEnrollment({
      id: 'enr-stale',
      contact_id: 'c2',
      next_run_at: new Date(Date.now() - 26 * 24 * HOUR).toISOString(),
    });

    const result = await run();

    expect(result.processed).toBe(1);
    expect(result.stale).toBe(1);
    expect(result.considered).toBe(2);
    // Distinct fields on the return shape, not one field doing double duty —
    // a caller can tell "sent 1, paused 1" apart from "sent 2" or "paused 2".
    expect(result).toHaveProperty('processed');
    expect(result).toHaveProperty('stale');
    expect(Object.keys(result).sort()).toEqual(['capped', 'considered', 'processed', 'stale', 'stopped'].sort());
  });

  it('applies the floor on the atomic-claim (RPC) path, not just the fallback', async () => {
    seedSequence();
    seedContactAndAccount();
    const enr = seedEnrollment({ next_run_at: new Date(Date.now() - 26 * 24 * HOUR).toISOString() });
    useRpcPath([enr]); // simulate claim_due_enrollments handing back the stale row

    const result = await run();

    expect(rpcCalls.some((c) => c.name === 'claim_due_enrollments')).toBe(true);
    expect(sentEmails).toHaveLength(0);
    const row = db.sequence_enrollments.find((r) => r.id === enr.id);
    expect(row.status).toBe('paused');
    expect(row.last_event).toMatch(/stale/i);
    expect(result.stale).toBe(1);
  });

  it('applies the floor on the plain-select fallback path when the RPC is absent', async () => {
    seedSequence();
    seedContactAndAccount();
    // rpcImpl.claim_due_enrollments defaults to an error in resetDb(), forcing
    // processDueEnrollments onto the fallback `.lte('next_run_at', now)` select.
    const enr = seedEnrollment({ next_run_at: new Date(Date.now() - 26 * 24 * HOUR).toISOString() });

    const result = await run();

    const row = db.sequence_enrollments.find((r) => r.id === enr.id);
    expect(row.status).toBe('paused');
    expect(sentEmails).toHaveLength(0);
    expect(result.stale).toBe(1);
  });
});

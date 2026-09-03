// Two related production fixes, tested against the REAL functions
// (decideAndWrite, writeEdge, recordFact) driven through a fake multi-table
// supabase client — never a mock of the module under test. Fake client
// pattern lifted from tests/memory-extraction-agent-memory.test.ts /
// tests/plan-store-batch.test.ts.
//
// CHANGE 1 (lib/memory/extract.ts, decideAndWrite): the extraction prompt asks
// the model for a `fact` field alongside subject/predicate/object, but does
// not require one. When the model omits it, `fact` was empty and the whole
// candidate was discarded via 'skipped: empty' — even though the SAME
// candidate's subject/predicate/object triple was everything writeEdge needed
// to record a graph edge. The fix composes "<subject> <predicate> <object>"
// (predicate underscores turned into spaces) from the triple when — and only
// when — the model supplied no usable fact text, and runs the composed text
// through the SAME exclusion/tier/length checks a model-supplied fact would
// go through.
//
// CHANGE 2 (lib/agent/memory.ts, recordFact): a rejected fact used to warn via
// a bare `log.warn`, carried no route, and only fired for source 'extraction'
// — silent for 'capability' and 'carryover'. Now every source logs via
// `log.request({ route: 'memory:record', ... }, 'warn')`, so it is findable
// alongside the extractor's own 'memory:extract' summary rows, and the fact
// TEXT is never included (only the rejection reason).

import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Record<string, any[]> = {};
let idSeq = 0;

/** Generic fluent fake, one array per table — same shape as
 *  tests/memory-extraction-agent-memory.test.ts. */
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

const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() };

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({ log: logMock }));
vi.mock('@/lib/agent/embeddings', () => ({
  embedPassage: vi.fn(async () => null),
  embedQuery: vi.fn(async () => null),
  embedPassages: vi.fn(async () => null),
  toPgVector: (v: number[]) => `[${v.join(',')}]`,
}));

const ACC = 'acct-1';

beforeEach(() => {
  vi.resetModules();
  db = {};
  idSeq = 0;
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
  logMock.request.mockClear();
});

describe('decideAndWrite composes a fact from the triple when the model omitted one', () => {
  it('a complete triple with NO fact string still results in a row in agent_memory, with readable composed text', async () => {
    const { decideAndWrite } = await import('@/lib/memory/extract');

    const decision = await decideAndWrite(
      ACC,
      {
        subject: { type: 'account', id: ACC, label: 'this account' },
        predicate: 'has_budget',
        object: '$65k',
        fact: '', // the model omitted it — exactly the production gap
      },
      'conv-1',
    );

    // The graph edge is written too — previously this candidate lost BOTH,
    // because the empty-fact check returned before writeEdge was ever called.
    expect(decision.outcome).toBe('written');
    expect(db.memory_edges?.length).toBe(1);

    expect(db.agent_memory?.length).toBe(1);
    const row = db.agent_memory![0];
    expect(row.account_id).toBe(ACC);
    // "<subject> <predicate with spaces> <object>" — short, natural,
    // human-readable prose, not a JSON blob.
    expect(row.fact).toBe('this account has budget $65k');
  });

  it('a model-supplied fact keeps that text unchanged — composition must not override a good fact', async () => {
    const { decideAndWrite } = await import('@/lib/memory/extract');

    const decision = await decideAndWrite(
      ACC,
      {
        subject: { type: 'account', id: ACC, label: 'this account' },
        predicate: 'has_budget',
        object: '$65k',
        fact: 'The account confirmed a $65k budget for this quarter.',
      },
      'conv-1',
    );

    expect(decision.outcome).toBe('written');
    expect(db.agent_memory?.length).toBe(1);
    expect(db.agent_memory![0].fact).toBe('The account confirmed a $65k budget for this quarter.');
  });

  it('a candidate with neither a fact string nor a complete triple is still rejected — composition does not fabricate a fact', async () => {
    const { decideAndWrite } = await import('@/lib/memory/extract');

    const decision = await decideAndWrite(
      ACC,
      {
        subject: { type: 'account', id: ACC, label: 'this account' },
        predicate: 'has_budget',
        object: '', // incomplete triple: object missing
        fact: '',
      },
      'conv-1',
    );

    expect(decision.outcome).toBe('skipped');
    expect(decision.rule).toBe('empty');
    expect(db.memory_edges?.length ?? 0).toBe(0);
    expect(db.agent_memory?.length ?? 0).toBe(0);
  });

  it('a secret-shaped composed fact is still rejected — composition cannot bypass the exclusion guard', async () => {
    const { decideAndWrite } = await import('@/lib/memory/extract');

    const decision = await decideAndWrite(
      ACC,
      {
        subject: { type: 'account', id: ACC, label: 'this account' },
        predicate: 'has_requirement',
        object: 'the api key on file',
        fact: '', // composes to "this account has requirement the api key on file"
      },
      'conv-1',
    );

    expect(decision.outcome).toBe('skipped');
    expect(decision.rule).toMatch(/^excluded:/);
    expect(db.memory_edges?.length ?? 0).toBe(0);
    expect(db.agent_memory?.length ?? 0).toBe(0);
  });
});

describe('recordFact rejection is logged via log.request(route: "memory:record") for every source', () => {
  it('logs route "memory:record" at warn, with source and reason, and never the fact text — for extraction', async () => {
    const { recordFact } = await import('@/lib/agent/memory');
    const secret = 'The API key is sk-live-abcdefghijklmnopqrstuvwxyz0123456789.';

    await recordFact(ACC, { fact: secret }, 'extraction');

    expect(logMock.request).toHaveBeenCalledTimes(1);
    const [fields, level] = logMock.request.mock.calls[0];
    expect(level).toBe('warn');
    expect(fields.route).toBe('memory:record');
    expect(fields.accountId).toBe(ACC);
    expect(fields.detail.source).toBe('extraction');
    expect(typeof fields.detail.reason).toBe('string');
    expect(fields.detail.reason).toMatch(/secret/i);
    // The rejection log must never carry the fact text itself.
    expect(JSON.stringify(fields)).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(db.agent_memory?.length ?? 0).toBe(0);
  });

  it('also logs for source "capability" (previously silent)', async () => {
    const { recordFact } = await import('@/lib/agent/memory');
    await recordFact(ACC, { fact: 'x'.repeat(600) }, 'capability');

    expect(logMock.request).toHaveBeenCalledTimes(1);
    const [fields, level] = logMock.request.mock.calls[0];
    expect(level).toBe('warn');
    expect(fields.route).toBe('memory:record');
    expect(fields.detail.source).toBe('capability');
    expect(fields.detail.reason).toMatch(/too long/i);
    expect(JSON.stringify(fields)).not.toContain('x'.repeat(600));
  });

  it('also logs for source "carryover" (previously silent)', async () => {
    const { recordFact } = await import('@/lib/agent/memory');
    const secret = 'password: sk-live-abcdefghijklmnopqrstuvwxyz0123456789';
    await recordFact(ACC, { fact: secret }, 'carryover');

    expect(logMock.request).toHaveBeenCalledTimes(1);
    const [fields, level] = logMock.request.mock.calls[0];
    expect(level).toBe('warn');
    expect(fields.route).toBe('memory:record');
    expect(fields.detail.source).toBe('carryover');
    expect(typeof fields.detail.reason).toBe('string');
    expect(JSON.stringify(fields)).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('an accepted fact is never logged through this path (only rejections are)', async () => {
    const { recordFact } = await import('@/lib/agent/memory');
    await recordFact(ACC, { fact: 'A perfectly ordinary durable fact.' }, 'capability');
    expect(logMock.request).not.toHaveBeenCalled();
    expect(db.agent_memory?.length).toBe(1);
  });
});

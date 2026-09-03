// Observability for the memory extractor — the packet that fixes two silent
// failure modes found by a production probe: 23 memory_edges rows written
// while agent_memory stayed at zero, with nothing in the logs explaining why.
//
// 1. `extractOne` used to log its per-fact decisions with `log.info`, which is
//    console-only (see lib/logger.ts) — the one line that would explain a
//    zero-write run never reached `app_logs`. Fixed: a persisted
//    `log.request(...)` summary, 'warn' when facts were proposed but none got
//    written, 'info' otherwise.
// 2. `recordFact` awaited a Supabase insert inside try/catch, but supabase-js
//    resolves `{ error }` on failure rather than throwing — a failing insert
//    was silently ignored. Fixed: the result's `error` is read and logged via
//    `log.warn`. A rejected fact, from ANY source (extraction, capability,
//    carryover), is also now logged — via `log.request` with route
//    'memory:record' at 'warn', reason only, never the fact text — see
//    tests/memory-record-fact-composition.test.ts for that behaviour in full.
//
// This file asserts the OBSERVABILITY behaviour only — what gets logged and
// at what level — not what gets extracted or written (that is covered by
// tests/memory-extraction-agent-memory.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Record<string, any[]> = {};
let idSeq = 0;

/** Same fake client as tests/memory-extraction-agent-memory.test.ts. */
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
vi.mock('@/lib/ai/router', () => ({ generateChat: vi.fn(), streamChat: vi.fn(), textConfigured: () => true }));
vi.mock('@/lib/agent/embeddings', () => ({
  embedPassage: vi.fn(async () => null),
  embedQuery: vi.fn(async () => null),
  embedPassages: vi.fn(async () => null),
  toPgVector: (v: number[]) => `[${v.join(',')}]`,
}));

const ACC = 'acct-1';

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
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
  logMock.request.mockClear();
});

describe('memory extraction — persisted summary log', () => {
  it('(a) a run where every write succeeds emits one persisted summary at level info with written === facts count', async () => {
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

    expect(summary.written).toBe(1);
    expect(logMock.request).toHaveBeenCalledTimes(1);
    const [fields, level] = logMock.request.mock.calls[0];
    expect(level ?? 'info').toBe('info');
    expect(fields.route).toBe('memory:extract');
    expect(fields.method).toBe('TICK');
    expect(fields.accountId).toBe(ACC);
    expect(fields.message).toBe('memory: extraction summary');
    expect(fields.detail.facts).toBe(1);
    expect(fields.detail.written).toBe(1);
    expect(fields.detail.skipped).toBe(0);
    expect(fields.detail.conversationId).toBe('conv-1');
    // Per-decision detail (subject/predicate text) must stay OUT of the
    // persisted row — only counts.
    expect(fields.detail.decisions).toBeUndefined();

    // The console-only line must be gone — this is the exact bug: log.info
    // never reaches app_logs, so the fix must not still be calling it for the
    // decisions summary.
    expect(logMock.info).not.toHaveBeenCalledWith('memory: extraction decisions', expect.anything());
  });

  it('(b) a run where every fact is unresolved emits the summary at level warn with the unresolved-subject rule counted', async () => {
    await seedConversation('conv-1');
    const { generateChat } = await import('@/lib/ai/router') as any;
    (generateChat as any).mockResolvedValue(JSON.stringify({
      facts: [
        { subject_type: 'contact', subject_label: 'Nobody McNoRecord', predicate: 'has_role', object: 'VP', fact: 'Nobody is VP.' },
        { subject_type: 'contact', subject_label: 'Also Unknown', predicate: 'has_role', object: 'CFO', fact: 'Also is CFO.' },
      ],
    }));

    const { runMemoryExtraction } = await import('@/lib/memory/extract');
    const summary = await runMemoryExtraction(5);

    expect(summary.written).toBe(0);
    expect(summary.skipped).toBe(2);
    expect(logMock.request).toHaveBeenCalledTimes(1);
    const [fields, level] = logMock.request.mock.calls[0];
    expect(level).toBe('warn');
    expect(fields.detail.written).toBe(0);
    expect(fields.detail.facts).toBe(2);
    expect(fields.detail.rules['unresolved-subject:contact']).toBe(2);
  });

  it('emits the summary at info, facts: 0, parseFailed: false, for a valid {"facts":[]} reply', async () => {
    await seedConversation('conv-1');
    const { generateChat } = await import('@/lib/ai/router') as any;
    (generateChat as any).mockResolvedValue(JSON.stringify({ facts: [] }));

    const { runMemoryExtraction } = await import('@/lib/memory/extract');
    await runMemoryExtraction(5);

    // This is exactly the case the guard used to swallow: decisions.length
    // is 0 (there was nothing to decide on), but the model call WAS attempted
    // and DID return a well-formed "nothing durable" answer — the summary
    // must still be emitted, at info, so this is distinguishable in app_logs
    // from a conversation the extractor silently never looked at.
    expect(logMock.request).toHaveBeenCalledTimes(1);
    const [fields, level] = logMock.request.mock.calls[0];
    expect(level ?? 'info').toBe('info');
    expect(fields.detail.facts).toBe(0);
    expect(fields.detail.parseFailed).toBe(false);
  });

  it('emits the summary at warn, facts: 0, parseFailed: true, when the model reply cannot be parsed into any facts', async () => {
    await seedConversation('conv-1');
    const { generateChat } = await import('@/lib/ai/router') as any;
    // Non-empty, non-JSON — parseFacts finds no {...} to match at all, so
    // facts.length is 0 despite the model having said something. This is the
    // exact case the coordinator flagged: with the old `if (decisions.length)`
    // guard this conversation emitted nothing, indistinguishable from a
    // completely uneventful tick.
    (generateChat as any).mockResolvedValue('Sorry, I cannot help with that request.');

    const { runMemoryExtraction } = await import('@/lib/memory/extract');
    const summary = await runMemoryExtraction(5);

    expect(summary.written).toBe(0);
    expect(logMock.request).toHaveBeenCalledTimes(1);
    const [fields, level] = logMock.request.mock.calls[0];
    expect(level).toBe('warn');
    expect(fields.detail.facts).toBe(0);
    expect(fields.detail.parseFailed).toBe(true);
  });
});

describe('recordFact — insert failures and rejections are logged', () => {
  it('(c) a mocked insert returning { error } calls log.warn once with that message and does not throw', async () => {
    vi.resetModules();
    logMock.warn.mockClear();
    vi.doMock('@/lib/db', () => ({
      supabase: {
        from: () => ({
          insert: async () => ({ error: { message: 'boom', code: '22P02' } }),
        }),
      },
      dbReady: () => true,
    }));
    const { recordFact } = await import('@/lib/agent/memory');

    await expect(recordFact('acct-1', { fact: 'A perfectly ordinary durable fact.' }, 'capability')).resolves.toBeUndefined();

    expect(logMock.warn).toHaveBeenCalledTimes(1);
    const [msg, detail] = logMock.warn.mock.calls[0];
    expect(msg).toBe('memory: recordFact insert failed');
    expect(detail.error).toBe('boom');
    expect(detail.code).toBe('22P02');
    expect(detail.accountId).toBe('acct-1');
  });

  it('(d) a rejected extraction fact is logged via log.request(route: memory:record) with the reason, not the fact text, and never inserts', async () => {
    await seedConversation('conv-1');
    logMock.request.mockClear();
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
    // The fact text itself must never appear anywhere in the logged fields.
    expect(JSON.stringify(fields)).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(db.agent_memory?.length ?? 0).toBe(0);
  });

  it('a rejected fact from a non-extraction source is also logged now (every source, not just extraction)', async () => {
    logMock.request.mockClear();
    const { recordFact } = await import('@/lib/agent/memory');
    await recordFact(ACC, { fact: 'x'.repeat(600) }, 'capability');
    expect(logMock.request).toHaveBeenCalledTimes(1);
    const [fields, level] = logMock.request.mock.calls[0];
    expect(level).toBe('warn');
    expect(fields.route).toBe('memory:record');
    expect(fields.detail.source).toBe('capability');
    expect(fields.detail.reason).toMatch(/too long/i);
  });
});

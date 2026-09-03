// Observability for the memory extractor's parse-failure diagnosis: a
// bounded, redacted sample of the raw model output is logged ONLY when
// parseFactsResult could not make sense of the reply — never on success —
// so the next production tick can tell a truncated JSON body apart from a
// code-fenced one, prose, or a plain refusal.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Observability: the raw sample is logged only on a parse failure, is
// length-capped, and is absent entirely on success.
// ---------------------------------------------------------------------------

let db: Record<string, any[]> = {};
let idSeq = 0;

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
      order() { return q; },
      limit(n: number) { q._limit = n; return q; },
      insert(input: any) {
        const arr = Array.isArray(input) ? input : [input];
        const created = arr.map((r: any) => ({ id: `id-${++idSeq}`, ...r }));
        rows().push(...created);
        const res = { data: created, error: null };
        return Object.assign(Promise.resolve(res), {
          select: () => Object.assign(Promise.resolve(res), { single: async () => ({ data: created[0], error: null }) }),
        });
      },
      update(p: any) { q._mode = 'update'; q._patch = p; return q; },
      _run(): any[] { return rows().filter((row: any) => q._f.every((f: any) => f(row))).slice(0, q._limit); },
      then(resolve: any) {
        if (q._mode === 'update') {
          const matched = rows().filter((row: any) => q._f.every((f: any) => f(row)));
          for (const row of matched) Object.assign(row, q._patch);
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
  { role: 'user', content: 'Northwind is dropping the enterprise segment entirely.' },
  { role: 'assistant', content: "Got it — I'll scope to seed-stage only." },
];

async function seedConversation(id: string) {
  db.agent_conversations = [{
    id, account_id: ACC, brand_id: null, transcript: FIXTURE_TRANSCRIPT,
    memory_extracted_at: null, updated_at: new Date().toISOString(),
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

describe('memory extraction — raw sample logged only on parse failure', () => {
  it('logs a bounded rawSample + rawLength when parsing fails', async () => {
    await seedConversation('conv-1');
    const { generateChat } = await import('@/lib/ai/router') as any;
    const longGarbage = 'Sorry, I cannot help with that request. '.repeat(20); // > 300 chars
    (generateChat as any).mockResolvedValue(longGarbage);

    const { runMemoryExtraction } = await import('@/lib/memory/extract');
    await runMemoryExtraction(5);

    expect(logMock.request).toHaveBeenCalledTimes(1);
    const [fields] = logMock.request.mock.calls[0];
    expect(fields.detail.parseFailed).toBe(true);
    expect(fields.detail.rawSample).toBeDefined();
    expect(fields.detail.rawSample.length).toBeLessThanOrEqual(300);
    expect(fields.detail.rawSample).toBe(longGarbage.slice(0, 300));
    expect(fields.detail.rawLength).toBe(longGarbage.length);
    expect(fields.detail.rawLength).toBeGreaterThan(300); // proves it's capped, not just short
  });

  it('does not log a rawSample when the parse succeeds, even with zero facts', async () => {
    await seedConversation('conv-1');
    const { generateChat } = await import('@/lib/ai/router') as any;
    (generateChat as any).mockResolvedValue(JSON.stringify({ facts: [] }));

    const { runMemoryExtraction } = await import('@/lib/memory/extract');
    await runMemoryExtraction(5);

    expect(logMock.request).toHaveBeenCalledTimes(1);
    const [fields] = logMock.request.mock.calls[0];
    expect(fields.detail.parseFailed).toBe(false);
    expect(fields.detail.rawSample).toBeUndefined();
    expect(fields.detail.rawLength).toBeUndefined();
  });

  it('does not log a rawSample when the model call fails outright (empty raw, not a parse failure)', async () => {
    await seedConversation('conv-1');
    const { generateChat } = await import('@/lib/ai/router') as any;
    (generateChat as any).mockRejectedValue(new Error('model unavailable'));

    const { runMemoryExtraction } = await import('@/lib/memory/extract');
    await runMemoryExtraction(5);

    expect(logMock.request).toHaveBeenCalledTimes(1);
    const [fields] = logMock.request.mock.calls[0];
    expect(fields.detail.parseFailed).toBe(false); // raw is empty, not a parse failure
    expect(fields.detail.rawSample).toBeUndefined();
  });
});

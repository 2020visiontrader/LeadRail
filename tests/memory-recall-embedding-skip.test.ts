// recallMemoryDigest / semanticRecall must not pay the NVIDIA embedding round
// trip when there is nothing in agent_memory for the account to search — that
// was happening on EVERY turn, for every account, because agent_memory was
// (see tests/memory-extraction-agent-memory.test.ts) always empty in
// production. This drives the real `semanticRecall` and `recallMemoryDigest`
// against a fake supabase, asserting the embedding call is skipped when the
// account has zero rows and made once rows exist.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let memory: any[] = [];

function makeClient() {
  function table(name: string) {
    const rows = () => (name === 'agent_memory' ? memory : []);
    const q: any = {
      _f: [] as ((r: any) => boolean)[],
      _order: [] as { col: string; asc: boolean }[],
      _limit: Infinity,
      select() { return q; },
      eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
      order(c: string, o?: { ascending?: boolean }) { q._order.push({ col: c, asc: o?.ascending !== false }); return q; },
      limit(n: number) { q._limit = n; return q; },
      then(resolve: any) {
        let r = rows().filter((row: any) => q._f.every((f: any) => f(row)));
        for (const o of [...q._order].reverse()) {
          r = r.slice().sort((a: any, b: any) => {
            const x = a[o.col], y = b[o.col];
            return x === y ? 0 : (x > y ? 1 : -1) * (o.asc ? 1 : -1);
          });
        }
        return resolve({ data: r.slice(0, q._limit), error: null });
      },
    };
    return q;
  }
  return {
    from: (t: string) => table(t),
    // match_agent_memory: return one plausible hit whenever called, so a test
    // that reaches this point can tell "the call happened" from "it happened
    // and found nothing" if it ever needs to.
    rpc: async (_fn: string, _params: any) => ({
      data: [{ fact: memory[0]?.fact ?? 'irrelevant', similarity: 0.4 }],
      error: null,
    }),
  };
}

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() } }));

const embedQuery = vi.fn(async (_text: string) => [0.1, 0.2, 0.3]);
vi.mock('@/lib/agent/embeddings', () => ({
  embedQuery: (text: string) => embedQuery(text),
  embedPassage: vi.fn(async () => null),
  embedPassages: vi.fn(async () => null),
  toPgVector: (v: number[]) => `[${v.join(',')}]`,
}));

const ACC = 'acct-1';

beforeEach(() => {
  vi.resetModules();
  memory = [];
  embedQuery.mockClear();
});

describe('semanticRecall skips the embedding call for an account with no memory', () => {
  it('does not call embedQuery when agent_memory has zero rows for the account', async () => {
    const { semanticRecall } = await import('@/lib/agent/memory');
    const result = await semanticRecall(ACC, 'what does this account prefer?');
    expect(result).toEqual([]);
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('calls embedQuery exactly once when the account has at least one memory row', async () => {
    memory.push({
      id: 'm-1', account_id: ACC, fact: 'Northwind only targets seed-stage B2B SaaS.',
      updated_at: new Date().toISOString(),
    });
    const { semanticRecall } = await import('@/lib/agent/memory');
    await semanticRecall(ACC, 'what does this account prefer?');
    expect(embedQuery).toHaveBeenCalledTimes(1);
  });

  it('does not let one account\'s memory rows trigger the embedding call for a different, empty account', async () => {
    memory.push({
      id: 'm-1', account_id: 'other-acct', fact: 'Some other account fact.',
      updated_at: new Date().toISOString(),
    });
    const { semanticRecall } = await import('@/lib/agent/memory');
    const result = await semanticRecall(ACC, 'what does this account prefer?');
    expect(result).toEqual([]);
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('recallMemoryDigest end-to-end: no embedding call with zero rows, one call once a fact exists', async () => {
    const { recallMemoryDigest } = await import('@/lib/agent/memory');

    const empty = await recallMemoryDigest(ACC, 12, 'what do we know about this account?');
    expect(empty).toBe('');
    expect(embedQuery).not.toHaveBeenCalled();

    memory.push({
      id: 'm-1', account_id: ACC, fact: 'Northwind only targets seed-stage B2B SaaS.',
      updated_at: new Date().toISOString(),
    });
    const withFact = await recallMemoryDigest(ACC, 12, 'what do we know about this account?');
    expect(withFact).toMatch(/seed-stage B2B SaaS/);
    expect(embedQuery).toHaveBeenCalledTimes(1);
  });
});

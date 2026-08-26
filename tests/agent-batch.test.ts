// Batching is how "reveal these 25 people" stops being 25 decisions. The tests
// that matter are the bounds — concurrency, size, and what a partial failure
// does — because this runs paid actions under one approval.

import { describe, it, expect } from 'vitest';
import { parseBatch, runBatch, batchSummary, MAX_BATCH } from '@/lib/agent/batch';

const ok = async (args: any) => ({ ok: true, result: args });

describe('parseBatch', () => {
  it('reports no batch for an ordinary single call', () => {
    expect(parseBatch({ action: 'tool', tool: 'x', args: { a: 1 } })).toEqual({ kind: 'none' });
  });

  it('accepts a list of argument objects', () => {
    const r = parseBatch({ calls: [{ a: 1 }, { a: 2 }] });
    expect(r.kind).toBe('batch');
    if (r.kind === 'batch') expect(r.calls.map((c) => c.args)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('refuses an envelope carrying BOTH args and calls', () => {
    // The model meant something specific; guessing which would run work nobody
    // asked for — and on a spend tool that is money.
    const r = parseBatch({ args: { a: 1 }, calls: [{ a: 2 }] });
    expect(r.kind).toBe('invalid');
  });

  it('ignores an empty args object alongside calls', () => {
    // `"args":{}` is noise, not an instruction.
    expect(parseBatch({ args: {}, calls: [{ a: 1 }] }).kind).toBe('batch');
  });

  it('refuses an empty batch', () => {
    expect(parseBatch({ calls: [] }).kind).toBe('invalid');
  });

  it('refuses a non-array', () => {
    expect(parseBatch({ calls: 'all of them' }).kind).toBe('invalid');
  });

  it('refuses entries that are not argument objects', () => {
    expect(parseBatch({ calls: [{ a: 1 }, 'oops'] }).kind).toBe('invalid');
    expect(parseBatch({ calls: [['a']] }).kind).toBe('invalid');
  });

  it('caps the batch, because one approval licenses all of it', () => {
    const r = parseBatch({ calls: Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ i })) });
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.reason).toContain(String(MAX_BATCH));
  });

  it('allows exactly the cap', () => {
    expect(parseBatch({ calls: Array.from({ length: MAX_BATCH }, (_, i) => ({ i })) }).kind).toBe('batch');
  });
});

describe('runBatch', () => {
  it('returns results in INPUT order regardless of completion order', async () => {
    const calls = [{ args: { ms: 30, id: 'a' } }, { args: { ms: 0, id: 'b' } }, { args: { ms: 15, id: 'c' } }];
    const results = await runBatch(calls, async (args) => {
      await new Promise((r) => setTimeout(r, args.ms));
      return { ok: true, result: args.id };
    });
    expect(results.map((r) => r.result)).toEqual(['a', 'b', 'c']);
  });

  it('never exceeds the concurrency limit', async () => {
    let live = 0;
    let peak = 0;
    const calls = Array.from({ length: 12 }, (_, i) => ({ args: { i } }));
    await runBatch(calls, async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return { ok: true };
    }, 3);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually concurrent, not accidentally serial
  });

  it('lets the good calls finish when some fail', async () => {
    // Three bad ids must not cost the twenty-two good ones — especially when
    // the good ones already spent credits.
    const calls = [{ args: { bad: true } }, { args: {} }, { args: { bad: true } }, { args: {} }];
    const results = await runBatch(calls, async (a) =>
      a.bad ? { ok: false, error: 'nope' } : { ok: true, result: 'fine' });
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toHaveLength(2);
  });

  it('records a thrown call as a failed one rather than losing the batch', async () => {
    const calls = [{ args: { boom: true } }, { args: {} }];
    const results = await runBatch(calls, async (a) => {
      if (a.boom) throw new Error('unexpected');
      return { ok: true };
    });
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('unexpected');
    expect(results[1].ok).toBe(true);
  });

  it('handles a single-item batch', async () => {
    expect(await runBatch([{ args: { a: 1 } }], ok)).toHaveLength(1);
  });
});

describe('batchSummary', () => {
  it('says so when everything worked', async () => {
    const r = await runBatch([{ args: {} }, { args: {} }], ok);
    expect(batchSummary('enrichLead', r)).toBe('enrichLead: all 2 succeeded.');
  });

  it('names the failures, which is the part worth reading', async () => {
    const r = await runBatch([{ args: {} }, { args: { bad: 1 } }], async (a) =>
      a.bad ? { ok: false, error: 'x' } : { ok: true });
    expect(batchSummary('enrichLead', r)).toBe('enrichLead: 1 of 2 succeeded, 1 failed.');
  });
});

// The resume path. A batch approval stores the WHOLE batch as its args, which
// is what makes the hash cover every item — and is also why resume cannot hand
// that object to the tool as if it were one call's arguments.
describe('batch approval round-trip', () => {
  it('recognises a stored batch when the approval comes back', () => {
    const stored = { calls: [{ externalId: 'a' }, { externalId: 'b' }] };
    const r = parseBatch(stored);
    expect(r.kind).toBe('batch');
    if (r.kind === 'batch') expect(r.calls).toHaveLength(2);
  });

  it('leaves an ordinary single approval alone', () => {
    // The single-call path must be untouched by any of this.
    expect(parseBatch({ contactId: 'abc' })).toEqual({ kind: 'none' });
  });
});

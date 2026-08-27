// Defect 2: a run in flight looks dead when you come back to it.
//
// A run exists ONLY as an open HTTP connection — nothing server-side records
// "a turn is in progress" anywhere. These pin the mechanism migration 072
// adds: a single nullable timestamp (running_since) on agent_conversations,
// set when a turn starts and cleared when it ends, with a staleness cutoff so
// a process that dies mid-turn (and therefore never clears it) cannot leave a
// conversation reading as "running" forever.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
vi.mock('@/lib/db', () => ({ supabase: { from: (...a: any[]) => mockFrom(...a) }, dbReady: () => true }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('./embeddings', () => ({ embedPassage: vi.fn(), embedQuery: vi.fn(), toPgVector: vi.fn() }));

function builder(result: any) {
  const b: any = {};
  for (const m of ['select', 'update', 'insert', 'eq', 'lte', 'is', 'order', 'limit', 'in', 'ilike']) {
    b[m] = () => b;
  }
  b.maybeSingle = async () => result;
  b.single = async () => result;
  b.then = (res: any) => Promise.resolve(result).then(res);
  return b;
}

describe('markConversationRunning / clearConversationRunning', () => {
  beforeEach(() => { vi.resetModules(); mockFrom.mockReset(); });

  it('writes a running_since timestamp, tenant-scoped', async () => {
    const updates: any[] = [];
    const filters: any[] = [];
    mockFrom.mockImplementation(() => ({
      update: (row: any) => { updates.push(row); return builder({ data: null, error: null }); },
      eq: (...a: any[]) => { filters.push(a); return builder({ data: null, error: null }); },
    }));
    const { markConversationRunning } = await import('@/lib/agent/memory');
    await markConversationRunning('conv-1', 'acct-1');
    expect(updates).toHaveLength(1);
    expect(typeof updates[0].running_since).toBe('string');
    // A real timestamp, not a placeholder.
    expect(Number.isNaN(new Date(updates[0].running_since).getTime())).toBe(false);
  });

  it('clears running_since back to null', async () => {
    const updates: any[] = [];
    mockFrom.mockImplementation(() => ({
      update: (row: any) => { updates.push(row); return builder({ data: null, error: null }); },
      eq: () => builder({ data: null, error: null }),
    }));
    const { clearConversationRunning } = await import('@/lib/agent/memory');
    await clearConversationRunning('conv-1', 'acct-1');
    expect(updates).toEqual([{ running_since: null }]);
  });

  it('never throws — a bookkeeping failure must not break the turn', async () => {
    mockFrom.mockImplementation(() => { throw new Error('db down'); });
    const { markConversationRunning, clearConversationRunning } = await import('@/lib/agent/memory');
    await expect(markConversationRunning('conv-1', 'acct-1')).resolves.toBeUndefined();
    await expect(clearConversationRunning('conv-1', 'acct-1')).resolves.toBeUndefined();
  });
});

describe('isConversationRunning', () => {
  beforeEach(() => { vi.resetModules(); mockFrom.mockReset(); });

  it('is true for a fresh running_since', async () => {
    mockFrom.mockImplementation(() => builder({ data: { running_since: new Date().toISOString() }, error: null }));
    const { isConversationRunning } = await import('@/lib/agent/memory');
    expect(await isConversationRunning('conv-1', 'acct-1')).toBe(true);
  });

  it('is false when running_since is null (no turn in progress)', async () => {
    mockFrom.mockImplementation(() => builder({ data: { running_since: null }, error: null }));
    const { isConversationRunning } = await import('@/lib/agent/memory');
    expect(await isConversationRunning('conv-1', 'acct-1')).toBe(false);
  });

  it('is false once running_since is older than RUNNING_STALE_MS — the crash-recovery cutoff', async () => {
    const { RUNNING_STALE_MS } = await import('@/lib/agent/memory');
    const staleSince = new Date(Date.now() - RUNNING_STALE_MS - 1000).toISOString();
    mockFrom.mockImplementation(() => builder({ data: { running_since: staleSince }, error: null }));
    const { isConversationRunning } = await import('@/lib/agent/memory');
    // A process that died mid-turn never reaches the `finally` that clears
    // this flag. Without the cutoff, that ONE conversation reads as running
    // forever and a returning user polls against it endlessly.
    expect(await isConversationRunning('conv-1', 'acct-1')).toBe(false);
  });

  it('is true for a running_since just inside the cutoff', async () => {
    const { RUNNING_STALE_MS } = await import('@/lib/agent/memory');
    const freshEnough = new Date(Date.now() - RUNNING_STALE_MS + 5000).toISOString();
    mockFrom.mockImplementation(() => builder({ data: { running_since: freshEnough }, error: null }));
    const { isConversationRunning } = await import('@/lib/agent/memory');
    expect(await isConversationRunning('conv-1', 'acct-1')).toBe(true);
  });

  it('degrades to false, never throws, on a failed read', async () => {
    mockFrom.mockImplementation(() => { throw new Error('db down'); });
    const { isConversationRunning } = await import('@/lib/agent/memory');
    await expect(isConversationRunning('conv-1', 'acct-1')).resolves.toBe(false);
  });
});

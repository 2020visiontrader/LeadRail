// Piece 2 of the in-flight stop fix: withStopWatch (lib/agent/stop-watch.ts)
// is the thing that actually notices a stop WHILE a model call is in
// flight — nothing else does, since the flag lives in Postgres and is set by
// a separate HTTP request. Direct unit tests of the helper itself, isolated
// from loop.ts and the router (those get their own integration coverage in
// tests/agent-stop-inflight.test.ts and tests/ai-router-stop.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const isStopRequestedMock = vi.fn();
vi.mock('@/lib/agent/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/memory')>();
  return { ...actual, isStopRequested: (...a: any[]) => isStopRequestedMock(...a) };
});

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  isStopRequestedMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withStopWatch — no conversationId', () => {
  it('calls run with undefined and never touches isStopRequested — no watcher, no polling', async () => {
    const { withStopWatch } = await import('@/lib/agent/stop-watch');
    const run = vi.fn(async (signal: AbortSignal | undefined) => {
      expect(signal).toBeUndefined();
      return 'ok';
    });

    const result = await withStopWatch(undefined, 'acct-1', run);

    expect(result).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    // Even after plenty of time, nothing was ever scheduled to poll.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(isStopRequestedMock).not.toHaveBeenCalled();
  });
});

describe('withStopWatch — polling and abort', () => {
  it('polls isStopRequested every STOP_POLL_MS while `run` is in flight, scoped by conversationId/accountId', async () => {
    const { withStopWatch, STOP_POLL_MS } = await import('@/lib/agent/stop-watch');
    expect(STOP_POLL_MS).toBe(3_000);
    isStopRequestedMock.mockResolvedValue(false);

    let resolveRun!: (v: string) => void;
    const run = vi.fn((_signal: AbortSignal | undefined) => new Promise<string>((res) => { resolveRun = res; }));

    const promise = withStopWatch('conv-1', 'acct-1', run);
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS * 3);
    expect(isStopRequestedMock).toHaveBeenCalledTimes(3);
    expect(isStopRequestedMock).toHaveBeenCalledWith('conv-1', 'acct-1');

    resolveRun('done');
    await expect(promise).resolves.toBe('done');
  });

  it('aborts the signal handed to `run` the moment isStopRequested flips true', async () => {
    const { withStopWatch, STOP_POLL_MS } = await import('@/lib/agent/stop-watch');
    isStopRequestedMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    let capturedSignal: AbortSignal | undefined;
    let rejectRun!: (e: unknown) => void;
    const run = vi.fn((signal: AbortSignal | undefined) => {
      capturedSignal = signal;
      return new Promise<string>((_res, rej) => {
        rejectRun = rej;
        signal?.addEventListener('abort', () => rej(new Error('aborted by watcher')));
      });
    });

    const promise = withStopWatch('conv-1', 'acct-1', run);
    // Swallow the eventual rejection so it never becomes an unhandled
    // rejection warning while assertions below are still pending.
    promise.catch(() => {});

    expect(capturedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS); // poll #1: false, no abort
    expect(capturedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS); // poll #2: true, aborts
    expect(capturedSignal?.aborted).toBe(true);

    await expect(promise).rejects.toThrow('aborted by watcher');
    void rejectRun; // referenced only to avoid an unused-variable warning
  });

  it('a transient isStopRequested read failure is fail-open — it does not abort the call', async () => {
    const { withStopWatch, STOP_POLL_MS } = await import('@/lib/agent/stop-watch');
    isStopRequestedMock.mockRejectedValue(new Error('db unavailable'));

    let resolveRun!: (v: string) => void;
    const run = vi.fn((signal: AbortSignal | undefined) => new Promise<string>((res) => {
      resolveRun = res;
      signal?.addEventListener('abort', () => { throw new Error('must never abort on a read failure'); });
    }));

    const promise = withStopWatch('conv-1', 'acct-1', run);
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS * 5);
    resolveRun('fine');
    await expect(promise).resolves.toBe('fine');
  });
});

describe('withStopWatch — cleanup', () => {
  it('clears the poll interval once `run` completes normally — no leaked timer', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const { withStopWatch, STOP_POLL_MS } = await import('@/lib/agent/stop-watch');
    isStopRequestedMock.mockResolvedValue(false);

    await withStopWatch('conv-1', 'acct-1', async () => 'ok');

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    const callCountAtCompletion = isStopRequestedMock.mock.calls.length;
    // Advance well past several poll intervals — a leaked timer would keep
    // calling isStopRequested; a properly cleared one calls it no more.
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS * 10);
    expect(isStopRequestedMock.mock.calls.length).toBe(callCountAtCompletion);
  });

  it('clears the poll interval even when `run` rejects (not caused by the watcher) — no leaked timer', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const { withStopWatch, STOP_POLL_MS } = await import('@/lib/agent/stop-watch');
    isStopRequestedMock.mockResolvedValue(false);

    await expect(withStopWatch('conv-1', 'acct-1', async () => { throw new Error('ordinary failure'); }))
      .rejects.toThrow('ordinary failure');

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    const callCountAtCompletion = isStopRequestedMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS * 10);
    expect(isStopRequestedMock.mock.calls.length).toBe(callCountAtCompletion);
  });
});

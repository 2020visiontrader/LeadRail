// Piece 1 of the in-flight stop fix (task: "leadrail assistant audit — close
// the mid-call stop gap"): each provider client accepts an optional external
// `signal` (lib/agent/stop-watch.ts's in-flight watcher) ALONGSIDE its own
// existing internal timeout AbortController — never a replacement for it.
// Both must be able to abort the same fetch, and the two outcomes must stay
// tellable apart: an external-signal abort surfaces as StoppedError (code
// 'stopped') so the router's candidate loop stops the whole call chain,
// while an internal-timeout abort surfaces exactly as it did before this
// file existed (a plain 'upstream' Error), so the router's existing
// fallback-to-next-candidate behaviour is completely unaffected.
//
// Every test also proves the additive guarantee: omit `signal` and the
// client's request/response handling is untouched (mirrors
// tests/ai-deadline-clients.test.ts's own additive-guarantee tests for
// `deadlineAt`).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// NOT a static top-level import: every test calls vi.resetModules() (needed
// so each client re-reads its env-var-derived KEY/TIMEOUT constants), and a
// class imported BEFORE that reset is a different module instance — and
// therefore a different class — than the one the freshly re-imported client
// throws. `instanceof` would silently fail against the stale reference. Each
// test instead imports StoppedError itself AFTER the reset, from the SAME
// module-registry epoch as the client under test.
let StoppedError: typeof import('@/lib/ai/abort').StoppedError;

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  ({ StoppedError } = await import('@/lib/ai/abort'));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENROUTER_MODEL;
});

/** A fetch mock whose promise settles only when ITS OWN `signal` argument
 *  aborts — i.e. it behaves like a call that is genuinely in flight until
 *  something (the internal timer OR the caller's external signal) aborts it.
 *  Mirrors what real `fetch` does when given an AbortSignal. */
function hangingFetch() {
  return vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    const signal = init.signal as AbortSignal;
    if (signal.aborted) {
      const err: any = new Error('aborted'); err.name = 'AbortError'; reject(err); return;
    }
    signal.addEventListener('abort', () => {
      const err: any = new Error('aborted'); err.name = 'AbortError'; reject(err);
    });
  }));
}

describe('zoask — external stop signal', () => {
  it('an external signal aborting mid-call throws StoppedError, not a timeout error', async () => {
    process.env.ZO_API_KEY = 'k';
    fetchMock.mockImplementation(hangingFetch());
    const { zoAskText } = await import('@/lib/ai/zoask');
    const ext = new AbortController();

    const promise = zoAskText({ prompt: 'hi', signal: ext.signal });
    ext.abort();

    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(StoppedError);
    expect(err.code).toBe('stopped');
    // Never described as a timeout — that would mislead anyone reading logs
    // into thinking the provider was slow, when the user asked to stop.
    expect(String(err.message)).not.toMatch(/timed out/i);
  });

  it('a signal that is already aborted before the call starts still throws StoppedError', async () => {
    process.env.ZO_API_KEY = 'k';
    fetchMock.mockImplementation(hangingFetch());
    const { zoAskText } = await import('@/lib/ai/zoask');
    const ext = new AbortController();
    ext.abort();

    await expect(zoAskText({ prompt: 'hi', signal: ext.signal })).rejects.toBeInstanceOf(StoppedError);
  });

  it('the internal timeout still fires and reports an ordinary timeout when no external signal is given (additive guarantee)', async () => {
    process.env.ZO_API_KEY = 'k';
    process.env.ZOASK_TIMEOUT_MS = '5';
    fetchMock.mockImplementation(hangingFetch());
    const { zoAskText } = await import('@/lib/ai/zoask');

    const err: any = await zoAskText({ prompt: 'hi' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(StoppedError);
    expect(err.code).toBe('upstream');
    expect(String(err.message)).toMatch(/timed out/i);
    delete process.env.ZOASK_TIMEOUT_MS;
  });

  it('with no signal, a normal successful call is completely unaffected', async () => {
    process.env.ZO_API_KEY = 'k';
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ output: 'hi there' }) });
    const { zoAskText } = await import('@/lib/ai/zoask');

    await expect(zoAskText({ prompt: 'hi' })).resolves.toBe('hi there');
  });
});

describe('opencode — external stop signal', () => {
  it('an external signal aborting mid-call (buffered) throws StoppedError', async () => {
    process.env.OPENCODE_API_KEY = 'k';
    fetchMock.mockImplementation(hangingFetch());
    const { generateChat } = await import('@/lib/ai/opencode');
    const ext = new AbortController();

    const promise = generateChat({ messages: [{ role: 'user', content: 'hi' }], signal: ext.signal });
    ext.abort();

    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(StoppedError);
    expect(err.code).toBe('stopped');
  });

  it('an external signal aborting mid-call (streaming) throws StoppedError', async () => {
    process.env.OPENCODE_API_KEY = 'k';
    fetchMock.mockImplementation(hangingFetch());
    const { streamChat } = await import('@/lib/ai/opencode');
    const ext = new AbortController();

    const promise = streamChat({ messages: [{ role: 'user', content: 'hi' }], signal: ext.signal }, () => {});
    ext.abort();

    await expect(promise).rejects.toBeInstanceOf(StoppedError);
  });

  it('with no signal, a normal successful call is completely unaffected', async () => {
    process.env.OPENCODE_API_KEY = 'k';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi there' } }] }),
    });
    const { generateChat } = await import('@/lib/ai/opencode');

    await expect(generateChat({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBe('hi there');
  });
});

describe('openrouter — external stop signal', () => {
  it('a stop-caused abort throws StoppedError and does NOT try the next model in the chain', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    // A multi-model chain so a fallback (if it happened) would be observable.
    process.env.OPENROUTER_MODEL = ''; // ensure default MODEL_CHAIN (4 entries) is used
    fetchMock.mockImplementation(hangingFetch());
    const { openrouterChat } = await import('@/lib/ai/openrouter');
    const ext = new AbortController();

    const promise = openrouterChat({ messages: [{ role: 'user', content: 'hi' }], signal: ext.signal });
    ext.abort();

    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(StoppedError);
    // Exactly ONE fetch — the chain never tried a second model after the stop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a stop-caused abort mid-stream throws StoppedError and does not fall back', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    process.env.OPENROUTER_MODEL = '';
    fetchMock.mockImplementation(hangingFetch());
    const { openrouterStreamChat } = await import('@/lib/ai/openrouter');
    const ext = new AbortController();

    const promise = openrouterStreamChat({ messages: [{ role: 'user', content: 'hi' }], signal: ext.signal }, () => {});
    ext.abort();

    await expect(promise).rejects.toBeInstanceOf(StoppedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an ordinary per-model timeout (no external signal) behaves exactly as before this change (additive guarantee)', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    process.env.OPENROUTER_TIMEOUT_MS = '5';
    process.env.OPENROUTER_MODEL = ''; // default multi-model chain
    fetchMock.mockImplementation(hangingFetch());
    const { openrouterChat } = await import('@/lib/ai/openrouter');

    const err: any = await openrouterChat({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    // A plain timeout carries no `status` (shouldTryNextModel only retries on
    // 402/404/429 — see openrouter.ts), so it throws on the FIRST model
    // exactly like it did before `signal` existed; this pins that today's
    // behaviour with no external signal is untouched, not that a timeout
    // falls through (it never did).
    expect(err).not.toBeInstanceOf(StoppedError);
    expect(err.code).toBe('upstream');
    expect(String(err.message)).toMatch(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    delete process.env.OPENROUTER_TIMEOUT_MS;
  });

  it('with no signal, a normal successful call is completely unaffected', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    process.env.OPENROUTER_MODEL = '';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi there' } }] }),
    });
    const { openrouterChat } = await import('@/lib/ai/openrouter');

    await expect(openrouterChat({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBe('hi there');
  });
});

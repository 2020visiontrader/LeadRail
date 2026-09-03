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

// GAP 2 (leadrail assistant audit): nim, gemini, and providers.ts's
// anthropic/custom branches did not accept `signal` at all until now. nim
// gets the same internal-timeout + AbortSignal.any pattern as zoask/opencode/
// openrouter above; gemini and providers.ts's fetch-based branches had NO
// existing timeout/AbortController to combine with, so `signal` is passed
// straight through as the fetch's own signal instead — see each client's own
// comment for why that is the least invasive addition, not a gap in parity.
describe('nim — external stop signal', () => {
  it('an external signal aborting mid-call throws StoppedError, not a timeout error', async () => {
    process.env.NVIDIA_API_KEY = 'k';
    fetchMock.mockImplementation(hangingFetch());
    const { nimText } = await import('@/lib/ai/nim');
    const ext = new AbortController();

    const promise = nimText({ prompt: 'hi', signal: ext.signal });
    ext.abort();

    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(StoppedError);
    expect(err.code).toBe('stopped');
    expect(String(err.message)).not.toMatch(/timed out/i);
  });

  it('a stop-caused abort does NOT try the next model in the chain', async () => {
    process.env.NVIDIA_API_KEY = 'k';
    fetchMock.mockImplementation(hangingFetch());
    const { nimChat } = await import('@/lib/ai/nim');
    const ext = new AbortController();

    const promise = nimChat({ messages: [{ role: 'user', content: 'hi' }], signal: ext.signal });
    ext.abort();

    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(StoppedError);
    // Exactly ONE fetch — the multi-model MODEL_CHAIN never tried a second
    // model after the stop (a StoppedError carries no `status`, so
    // shouldTryNextModel(0) is false — see nim.ts's complete()).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the internal timeout still fires and reports an ordinary timeout when no external signal is given (additive guarantee)', async () => {
    process.env.NVIDIA_API_KEY = 'k';
    process.env.NIM_TIMEOUT_MS = '5';
    process.env.NIM_MODEL = 'test/model'; // pin a single model so retries can't mask the timeout
    fetchMock.mockImplementation(hangingFetch());
    const { nimText } = await import('@/lib/ai/nim');

    const err: any = await nimText({ prompt: 'hi' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(StoppedError);
    expect(err.code).toBe('upstream');
    expect(String(err.message)).toMatch(/timed out/i);
    delete process.env.NIM_TIMEOUT_MS;
    delete process.env.NIM_MODEL;
  });

  it('with no signal, a normal successful call is completely unaffected', async () => {
    process.env.NVIDIA_API_KEY = 'k';
    process.env.NIM_MODEL = 'test/model';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi there' } }] }),
    });
    const { nimText } = await import('@/lib/ai/nim');

    await expect(nimText({ prompt: 'hi' })).resolves.toBe('hi there');
    delete process.env.NIM_MODEL;
  });
});

describe('gemini — external stop signal', () => {
  it('an external signal aborting mid-call throws StoppedError, not a plain abort error', async () => {
    process.env.Gemini_api_key = 'k';
    fetchMock.mockImplementation(hangingFetch());
    const { generateText } = await import('@/lib/ai/gemini');
    const ext = new AbortController();

    const promise = generateText({ prompt: 'hi', signal: ext.signal });
    ext.abort();

    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(StoppedError);
    expect(err.code).toBe('stopped');
  });

  it('an external signal aborting a chat call throws StoppedError', async () => {
    process.env.Gemini_api_key = 'k';
    fetchMock.mockImplementation(hangingFetch());
    const { generateChat } = await import('@/lib/ai/gemini');
    const ext = new AbortController();

    const promise = generateChat({ messages: [{ role: 'user', content: 'hi' }], signal: ext.signal });
    ext.abort();

    await expect(promise).rejects.toBeInstanceOf(StoppedError);
  });

  it('with no signal, a normal successful call is completely unaffected (additive guarantee)', async () => {
    process.env.Gemini_api_key = 'k';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'hi there' }] } }] }),
    });
    const { generateText } = await import('@/lib/ai/gemini');

    await expect(generateText({ prompt: 'hi' })).resolves.toBe('hi there');
  });
});

describe('providers.ts callModel (anthropic/custom kinds) — external stop signal', () => {
  function providerRow(kind: 'anthropic' | 'custom', baseUrl: string | null): any {
    return {
      id: 'p1', account_id: 'a1', name: 'Test Provider', kind,
      base_url: baseUrl, api_key_encrypted: null, enabled: true,
      created_at: '', updated_at: '',
    };
  }
  function modelRow(): any {
    return {
      id: 'm1', provider_id: 'p1', model_id: 'test-model', label: null,
      tier: 'balanced', good: [], reliable: true, enabled: true,
      max_output_tokens: null, context_window: null,
    };
  }

  it('anthropic: an external signal aborting mid-call throws StoppedError', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    fetchMock.mockImplementation(hangingFetch());
    const { callModel } = await import('@/lib/ai/providers');
    const ext = new AbortController();

    const promise = callModel(
      { provider: providerRow('anthropic', null), model: modelRow() },
      { prompt: 'hi', signal: ext.signal },
    );
    ext.abort();

    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(StoppedError);
    expect(err.code).toBe('stopped');
  });

  it('anthropic: with no signal, a normal successful call is completely unaffected (additive guarantee)', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: 'hi there' }] }),
    });
    const { callModel } = await import('@/lib/ai/providers');

    await expect(callModel(
      { provider: providerRow('anthropic', null), model: modelRow() },
      { prompt: 'hi' },
    )).resolves.toBe('hi there');
  });

  it('custom (openai-compatible): an external signal aborting mid-call throws StoppedError', async () => {
    // 'custom' kind has no dedicated KIND_ENV_KEY entry — decryptProviderKey
    // resolves it by base_url host instead (see providers.ts), so an
    // openrouter.ai base_url picks up OPENROUTER_API_KEY without needing the
    // vault/crypto path.
    process.env.OPENROUTER_API_KEY = 'k';
    fetchMock.mockImplementation(hangingFetch());
    const { callModel } = await import('@/lib/ai/providers');
    const ext = new AbortController();

    const promise = callModel(
      { provider: providerRow('custom', 'https://openrouter.ai/api/v1'), model: modelRow() },
      { prompt: 'hi', signal: ext.signal },
    );
    ext.abort();

    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(StoppedError);
    expect(err.code).toBe('stopped');
  });

  it('custom (openai-compatible): with no signal, a normal successful call is completely unaffected (additive guarantee)', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi there' } }] }),
    });
    const { callModel } = await import('@/lib/ai/providers');

    await expect(callModel(
      { provider: providerRow('custom', 'https://openrouter.ai/api/v1'), model: modelRow() },
      { prompt: 'hi' },
    )).resolves.toBe('hi there');
  });
});

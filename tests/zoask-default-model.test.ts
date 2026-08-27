// Regression: the registry's "Zo Ask (account default)" row stores the sentinel
// `__default__` as its model_id, and lib/ai/providers.ts forwards model_id into
// zoAskChat verbatim. Nothing treated it as a sentinel, so every account-registry
// chat call posted {"model_name": "__default__"} and Zo Ask answered 502 — 76
// consecutive failures on that path while the ladder path (which passes no model,
// so the field is omitted) logged 31 successes against the same key in the same
// minutes.
//
// What these assert is the WIRE BODY, not a return value: the bug was never
// visible in what zoAskChat returned, only in what it sent.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function ok(output = 'hi') {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ output }) });
}

/** The JSON body of the single request the last call made. */
function sentBody(): any {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

const MESSAGES = [{ role: 'user' as const, content: 'hello' }];

describe('zoAsk model_name on the wire', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    process.env.ZO_API_KEY = 'test-key';
    delete process.env.ZOASK_MODEL;
  });

  it('OMITS model_name for the __default__ sentinel (the 502 bug)', async () => {
    ok();
    const { zoAskChat } = await import('@/lib/ai/zoask');
    await zoAskChat({ messages: MESSAGES, model: '__default__' });
    expect(sentBody()).not.toHaveProperty('model_name');
  });

  it('omits model_name for the other default spellings', async () => {
    for (const sentinel of ['default', 'auto', '', '  __default__  ']) {
      fetchMock.mockReset();
      ok();
      const { zoAskChat } = await import('@/lib/ai/zoask');
      await zoAskChat({ messages: MESSAGES, model: sentinel });
      expect(sentBody(), `sentinel ${JSON.stringify(sentinel)}`).not.toHaveProperty('model_name');
    }
  });

  it('omits model_name when no model is given at all (the ladder path)', async () => {
    ok();
    const { zoAskChat } = await import('@/lib/ai/zoask');
    await zoAskChat({ messages: MESSAGES });
    expect(sentBody()).not.toHaveProperty('model_name');
  });

  it('STILL sends a real model id — the fix must not swallow a genuine override', async () => {
    ok();
    const { zoAskChat } = await import('@/lib/ai/zoask');
    await zoAskChat({ messages: MESSAGES, model: 'byok:claude-opus-4' });
    expect(sentBody().model_name).toBe('byok:claude-opus-4');
  });

  it('falls back to ZOASK_MODEL when the caller passes a sentinel', async () => {
    // `modelOverride || MODEL` means an empty-string override already fell
    // through to the env var; the sentinel check must not change that.
    process.env.ZOASK_MODEL = 'byok:env-model';
    ok();
    const { zoAskChat } = await import('@/lib/ai/zoask');
    await zoAskChat({ messages: MESSAGES, model: '' });
    expect(sentBody().model_name).toBe('byok:env-model');
  });
});

// Fix 2 (see the task spec this shipped under). PRODUCTION EVIDENCE,
// 2026-09-02: an OpenRouter call was paid for and rejected with "maximum
// context length is 131072" — MODEL_CHAIN's openai/gpt-oss-120b (~131K) was
// attempted (and paid for) with a prompt it plainly could not hold, because
// shouldTryNextModel() only covered 402/404/429, not a 400 context-length
// rejection, and nothing filtered the chain by prompt size up front.
//
// Two independent fixes are pinned here:
//  1. eligibleChainFor (internal to openrouter.ts, exercised through
//     openrouterChat/openrouterText) skips a chain model whose KNOWN window
//     the estimated prompt cannot fit, BEFORE any request is sent — but never
//     empties the chain; an oversized prompt still reaches a provider.
//  2. A 400 whose body names a context-length problem now advances to the
//     next model, same as a 402/404/429 always did; a 400 for any other
//     reason keeps aborting exactly as before.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  process.env.OPENROUTER_API_KEY = 'k';
  delete process.env.OPENROUTER_MODEL;
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
});

function resOk(content: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
}
function resFail(status: number, body: string) {
  return {
    ok: false,
    status,
    text: async () => body,
    headers: { get: () => null },
  };
}

describe('eligibleChainFor — filters MODEL_CHAIN by estimated prompt size', () => {
  it('skips openai/gpt-oss-120b (~128K window) but still attempts haiku (200K) for an oversized prompt', async () => {
    // ~130,000 estimated tokens (520,000 chars / 4) at HEADROOM 1.15 needs
    // ~149,600 — over gpt-oss-120b's 128K window, under haiku's 200K and
    // sonnet-5's 1M. Fail the first two eligible models so the THIRD call
    // proves gpt-oss-120b was never reached, not merely that haiku was tried
    // first.
    fetchMock
      .mockResolvedValueOnce(resFail(429, 'rate limited'))   // haiku — eligible, fails
      .mockResolvedValueOnce(resFail(429, 'rate limited'))   // luna — unknown window, always kept, fails
      .mockResolvedValueOnce(resOk('sonnet answer'));         // sonnet-5 — eligible, answers

    const bigContent = 'x'.repeat(520_000);
    const { openrouterChat, MODEL_CHAIN } = await import('@/lib/ai/openrouter');
    const result = await openrouterChat({
      messages: [{ role: 'user', content: bigContent }],
      maxOutputTokens: 100,
    });

    expect(result).toBe('sonnet answer');
    const bodies = fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body));
    expect(bodies[0].model).toBe(MODEL_CHAIN[0]); // haiku, attempted first
    expect(bodies.map((b: any) => b.model)).not.toContain('openai/gpt-oss-120b');
    expect(bodies.at(-1).model).toBe('anthropic/claude-sonnet-5');
  });

  it('never empties the chain: a prompt over every KNOWN window still attempts the chain unfiltered', async () => {
    // Pin the chain to a single, KNOWN-window model (haiku, 200K) so the
    // filter has nothing unknown to fall back on keeping. A prompt this large
    // makes eligibleChainFor's `kept` array empty, which must return the
    // chain UNFILTERED rather than throwing a client-side "nothing eligible"
    // error — the request still reaches the provider and fails (or succeeds)
    // on the provider's own terms.
    process.env.OPENROUTER_MODEL = 'anthropic/claude-haiku-4.5';
    vi.resetModules();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(resOk('answered anyway'));

    // ~300,000 estimated tokens — over haiku's 200K window even before
    // HEADROOM/maxTokens are added.
    const hugeContent = 'x'.repeat(1_200_000);
    const { openrouterChat } = await import('@/lib/ai/openrouter');
    const result = await openrouterChat({
      messages: [{ role: 'user', content: hugeContent }],
      maxOutputTokens: 100,
    });

    // The call was still ATTEMPTED (fetch happened) rather than rejected
    // before ever reaching the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBe('answered anyway');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('anthropic/claude-haiku-4.5');
  });
});

describe('400 context-length rejections advance the chain; other 400s do not', () => {
  it('a 400 naming "maximum context length" advances to the next model', async () => {
    fetchMock
      .mockResolvedValueOnce(resFail(400, 'This endpoint\'s maximum context length is 131072 tokens.'))
      .mockResolvedValueOnce(resOk('luna answer'));

    const { openrouterChat, MODEL_CHAIN } = await import('@/lib/ai/openrouter');
    const result = await openrouterChat({
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
    });

    expect(result).toBe('luna answer');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body));
    expect(bodies[0].model).toBe(MODEL_CHAIN[0]);
    expect(bodies[1].model).toBe(MODEL_CHAIN[1]);
  });

  it('a 400 for an unrelated reason still aborts the whole chain, unchanged', async () => {
    fetchMock.mockResolvedValue(resFail(400, 'Invalid parameter: temperature must be between 0 and 2'));

    const { openrouterChat } = await import('@/lib/ai/openrouter');
    await expect(
      openrouterChat({ messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100 }),
    ).rejects.toMatchObject({ status: 400 });

    // Only the first model was ever tried — a non-context 400 is not a
    // reason to burn the rest of the (paid) chain.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

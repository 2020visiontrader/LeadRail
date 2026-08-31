// Fix 3 (see the task spec this shipped under). PRODUCTION EVIDENCE,
// 2026-08-31: OpenRouter refused anthropic/claude-haiku-4.5 with a 402 body
// reading "This request requires more credits, or fewer max_tokens. You
// requested up to 16000 tokens, but can only afford 4605." — the account had
// SOME credit, just not enough to cover the requested output ceiling
// (lib/agent/loop.ts's AGENT_ROUTE_CEILING). Before this fix, any 402 fell
// straight to shouldTryNextModel(), abandoning the model entirely instead of
// retrying it with a cap it could actually afford.

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
  process.env.OPENROUTER_MODEL = 'test/pinned-model'; // collapse MODEL_CHAIN to one entry
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
});

function res402(body: string) {
  return { ok: false, status: 402, text: async () => body };
}
function res200(content: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
}

describe('parseAffordableTokens', () => {
  it('parses the production wording', async () => {
    const { parseAffordableTokens } = await import('@/lib/ai/openrouter');
    expect(parseAffordableTokens(
      'This request requires more credits, or fewer max_tokens. You requested up to 16000 tokens, but can only afford 4605.',
    )).toBe(4605);
  });

  it('strips thousands separators', async () => {
    const { parseAffordableTokens } = await import('@/lib/ai/openrouter');
    expect(parseAffordableTokens('can only afford 4,605')).toBe(4605);
  });

  it('returns null when no number is present (defensive parsing)', async () => {
    const { parseAffordableTokens } = await import('@/lib/ai/openrouter');
    expect(parseAffordableTokens('This request would exceed your available credits given your current in-flight requests.')).toBeNull();
  });

  it('returns null for undefined/empty input', async () => {
    const { parseAffordableTokens } = await import('@/lib/ai/openrouter');
    expect(parseAffordableTokens(undefined)).toBeNull();
    expect(parseAffordableTokens('')).toBeNull();
  });

  it('returns null for a non-numeric or zero match', async () => {
    const { parseAffordableTokens } = await import('@/lib/ai/openrouter');
    expect(parseAffordableTokens('can only afford 0')).toBeNull();
  });
});

describe('openrouterChat — 402 affordable-ceiling retry', () => {
  it('retries the SAME model once with the smaller cap OpenRouter named, and succeeds without falling to the next model', async () => {
    fetchMock
      .mockResolvedValueOnce(res402('You requested up to 16000 tokens, but can only afford 4605.'))
      .mockResolvedValueOnce(res200('the answer'));

    const { openrouterChat } = await import('@/lib/ai/openrouter');
    const result = await openrouterChat({ messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16000 });

    expect(result).toBe('the answer');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.max_tokens).toBe(16000);
    expect(firstBody.model).toBe('test/pinned-model');
    // Retried the SAME model, just with the smaller, affordable cap.
    expect(secondBody.model).toBe('test/pinned-model');
    expect(secondBody.max_tokens).toBe(4605);
  });

  it('an unparseable 402 falls through unchanged — no retry, straight to the next model (or throw, on a single-model chain)', async () => {
    fetchMock.mockResolvedValue(res402('This request would exceed your available credits given your current in-flight requests.'));

    const { openrouterChat } = await import('@/lib/ai/openrouter');
    await expect(
      openrouterChat({ messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16000 }),
    ).rejects.toMatchObject({ status: 402 });

    // No affordable ceiling parsed -> no retry attempt was made; with the
    // chain collapsed to one model (shouldTryNextModel has nowhere to go),
    // exactly one fetch happens, identical to pre-fix behaviour for an
    // unparseable 402.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not hardcode 4605 — a different affordable number in the body is honoured exactly', async () => {
    fetchMock
      .mockResolvedValueOnce(res402('You requested up to 16000 tokens, but can only afford 9001.'))
      .mockResolvedValueOnce(res200('ok'));

    const { openrouterChat } = await import('@/lib/ai/openrouter');
    await openrouterChat({ messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16000 });

    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.max_tokens).toBe(9001);
  });

  it('falls through to the next model in a multi-model chain when the retry itself also fails', async () => {
    delete process.env.OPENROUTER_MODEL; // use the real 4-model MODEL_CHAIN
    vi.resetModules();
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(res402('You requested up to 16000 tokens, but can only afford 4605.')) // model 1, first try
      .mockResolvedValueOnce(res402('still not enough'))                                             // model 1, retry at 4605 — still 402, unparseable this time
      .mockResolvedValueOnce(res200('answer from model 2'));                                          // model 2

    const { openrouterChat, MODEL_CHAIN } = await import('@/lib/ai/openrouter');
    const result = await openrouterChat({ messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16000 });

    expect(result).toBe('answer from model 2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body));
    expect(bodies[0].model).toBe(MODEL_CHAIN[0]);
    expect(bodies[0].max_tokens).toBe(16000);
    expect(bodies[1].model).toBe(MODEL_CHAIN[0]); // same-model retry
    expect(bodies[1].max_tokens).toBe(4605);
    expect(bodies[2].model).toBe(MODEL_CHAIN[1]); // fell through to the next model
  });
});

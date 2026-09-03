// Context audit C11 — Zo Ask, the primary tier, never returns a usage block,
// so every one of its successful calls used to log tokens_in NULL: 299 of 299
// in the 14 days that prompted this audit, ~60% of spend invisible to
// ai_usage. The FAILURE path already had `failureUsage` (see
// tests/ai-usage-failed-call-estimate.test.ts) to fall back to an estimate;
// the success path had none — a successful Zo Ask call passed
// `outcome.usage` (null) straight through to `logUsage`.
//
// This drives the REAL router (lib/ai/router.ts) against a stubbed fetch and
// asserts on the object recordAiUsage actually receives, same pattern as the
// failure-path test: the bug lives in the control flow between the capture
// scope and the insert, not inside either one.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const recordAiUsage = vi.fn(async (_entry: any) => 'row-id');
vi.mock('@/lib/credits', () => ({ recordAiUsage: (entry: any) => recordAiUsage(entry) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));

/** logUsage is fire-and-forget (`void logUsage(...)`) on the success path. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('a successful call that reported no usage records an ESTIMATE, not NULL', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    recordAiUsage.mockClear();
    delete process.env.ZO_API_KEY;
    delete process.env.ZOASK_MODEL;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.HF_TOKEN;
    delete process.env.AI_PROMPT_CACHE_MARKERS;
  });

  it('Zo Ask (reports nothing) logs tokens_in/tokens_out as estimates, source estimated', async () => {
    process.env.ZO_API_KEY = 'test-key';
    // Zo Ask's body is `{output}` — never a usage block, success or failure.
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ output: 'y'.repeat(40) }) });

    // 4000 chars of prompt -> estimateTokens (4 chars/token) -> 1000 tokens.
    const prompt = 'x'.repeat(4000);
    const { generateText } = await import('@/lib/ai/router');
    const { estimateTokens } = await import('@/lib/ai/eligibility');
    const text = await generateText({ prompt, accountId: 'acct-1' });
    expect(text).toBe('y'.repeat(40));
    await flush();

    expect(recordAiUsage).toHaveBeenCalled();
    const arg: any = recordAiUsage.mock.calls[0]![0];
    expect(arg.ok).toBe(true);
    // Same estimate the selector sized the call with — the row and the
    // routing decision behind it cannot disagree.
    expect(arg.tokensIn).toBe(estimateTokens(prompt));
    expect(arg.tokensIn).toBe(1000);
    // Estimated from the text the call actually returned.
    expect(arg.tokensOut).toBe(estimateTokens('y'.repeat(40)));
    expect(arg.tokensOut).toBe(10);
    // Never presentable as a measurement.
    expect(arg.usageSource).toBe('estimated');
    // usageStatus stays what the capture scope observed about the PROVIDER
    // (Zo Ask explicitly reports "parsed fine, no usage field") — an
    // estimate must never read back as 'reported'.
    expect(arg.usageStatus).toBe('provider_not_reported');
    expect(arg.usageStatus).not.toBe('reported');
  });

  it('a provider that DOES report usage on success keeps its own numbers, untouched', async () => {
    process.env.OPENCODE_API_KEY = 'test-key';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello there' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }),
    });

    const { generateText } = await import('@/lib/ai/router');
    expect(await generateText({ prompt: 'hi', accountId: 'acct-1' })).toBe('hello there');
    await flush();

    const arg: any = recordAiUsage.mock.calls[0]![0];
    expect(arg.ok).toBe(true);
    expect(arg.tokensIn).toBe(10);
    expect(arg.tokensOut).toBe(3);
    expect(arg.usageSource).toBe('provider');
    expect(arg.usageStatus).toBe('reported');
  });
});

describe('successUsage — the pure decision, unit tested without the network', () => {
  it('captured tokensIn present -> passthrough, reported/provider, regardless of text', async () => {
    const { successUsage } = await import('@/lib/ai/router');
    const captured = {
      usage: { tokensIn: 55, tokensOut: 12 }, status: 'reported' as const, source: 'provider' as const,
      timingMs: null, timingStatus: 'not_attempted' as const, timingSource: 'none' as const,
    };
    const result = successUsage({ promptTokens: 999 }, captured, 'irrelevant, long completion text');
    expect(result).toEqual({ usage: { tokensIn: 55, tokensOut: 12 }, status: 'reported', source: 'provider' });
  });

  it('captured usage absent (null) -> estimate both sides, source estimated, status kept', async () => {
    const { successUsage } = await import('@/lib/ai/router');
    const captured = {
      usage: null, status: 'provider_not_reported' as const, source: 'none' as const,
      timingMs: null, timingStatus: 'not_attempted' as const, timingSource: 'none' as const,
    };
    const result = successUsage({ promptTokens: 250 }, captured, 'z'.repeat(80)); // 80 chars -> 20 tokens
    expect(result).toEqual({ usage: { tokensIn: 250, tokensOut: 20 }, status: 'provider_not_reported', source: 'estimated' });
  });

  it('captured usage present but tokensIn null -> still falls to estimate, not treated as reported', async () => {
    const { successUsage } = await import('@/lib/ai/router');
    const captured = {
      usage: { tokensIn: null, tokensOut: 40 }, status: 'reported' as const, source: 'provider' as const,
      timingMs: null, timingStatus: 'not_attempted' as const, timingSource: 'none' as const,
    };
    const result = successUsage({ promptTokens: 300 }, captured, 'w'.repeat(40)); // 40 chars -> 10 tokens
    expect(result).toEqual({ usage: { tokensIn: 300, tokensOut: 10 }, status: 'reported', source: 'estimated' });
  });
});

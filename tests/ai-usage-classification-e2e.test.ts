// End-to-end check that a usage classification computed by lib/ai/usage.ts
// actually reaches the ai_usage insert — not just that the classification
// function returns the right value in isolation (that's
// ai-usage-capture.test.ts), and not just that a provider client calls the
// right reporter (that's ai-usage-streaming.test.ts / the zoask suite below).
// This drives the real router (lib/ai/router.ts) against a stubbed Zo Ask
// fetch and asserts on the object recordAiUsage actually receives.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const recordAiUsage = vi.fn(async (_entry: any) => 'row-id');
vi.mock('@/lib/credits', () => ({ recordAiUsage: (entry: any) => recordAiUsage(entry) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));

describe('router plumbs usage classification into recordAiUsage', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    recordAiUsage.mockClear();
    process.env.ZO_API_KEY = 'test-key';
    delete process.env.ZOASK_MODEL;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.HF_TOKEN;
  });

  it('a Zo Ask answer (no usage field) logs usage_status: provider_not_reported, usage_source: none', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ output: 'hello there' }) });

    const { generateText } = await import('@/lib/ai/router');
    const text = await generateText({ prompt: 'hi', accountId: 'acct-1' });
    expect(text).toBe('hello there');

    // logUsage is fire-and-forget (`void logUsage(...)`), so give the
    // microtask queue a turn before asserting on the mock.
    await new Promise((r) => setTimeout(r, 0));

    expect(recordAiUsage).toHaveBeenCalledTimes(1);
    const arg: any = recordAiUsage.mock.calls[0]![0];
    expect(arg.ok).toBe(true);
    expect(arg.tokensIn).toBeNull();
    expect(arg.tokensOut).toBeNull();
    expect(arg.usageStatus).toBe('provider_not_reported');
    expect(arg.usageSource).toBe('none');
    // Same absence rule, same reason, for provider-reported timing (migration
    // 078): Zo Ask's `{output}` body never carries a duration field either.
    expect(arg.providerLatencyMs).toBeNull();
    expect(arg.timingStatus).toBe('provider_not_reported');
    expect(arg.timingSource).toBe('none');
  });

  it('an OpenCode answer that DOES carry generation_time logs timingStatus: reported, timingSource: provider, and the real number', async () => {
    delete process.env.ZO_API_KEY;
    process.env.OPENCODE_API_KEY = 'test-key';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello there' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, generation_time: 611 },
      }),
    });

    const { generateText } = await import('@/lib/ai/router');
    const text = await generateText({ prompt: 'hi', accountId: 'acct-1' });
    expect(text).toBe('hello there');

    await new Promise((r) => setTimeout(r, 0));

    expect(recordAiUsage).toHaveBeenCalledTimes(1);
    const arg: any = recordAiUsage.mock.calls[0]![0];
    expect(arg.ok).toBe(true);
    // providerLatencyMs is the actual column name recordAiUsage/credits.ts
    // writes ai_usage.provider_latency_ms from — proving the value reaches
    // the insert call, not just the router's internal usage-capture return.
    expect(arg.providerLatencyMs).toBe(611);
    expect(arg.timingStatus).toBe('reported');
    expect(arg.timingSource).toBe('provider');
  });

  it('a failed candidate logs no timing classification at all (absent, not a guessed value)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });

    const { generateText } = await import('@/lib/ai/router');
    await expect(generateText({ prompt: 'hi', accountId: 'acct-1' })).rejects.toThrow();

    await new Promise((r) => setTimeout(r, 0));

    expect(recordAiUsage).toHaveBeenCalledTimes(1);
    const arg: any = recordAiUsage.mock.calls[0]![0];
    expect(arg.ok).toBe(false);
    // logUsage's failure branch never passes timingMs/timingStatus/timingSource
    // at all — logUsage's own `?? not_attempted`/`?? none` defaults (mirroring
    // usageStatus/usageSource on this same branch) are what land in the object
    // recordAiUsage actually receives, not a guessed classification.
    expect(arg.providerLatencyMs).toBeNull();
    expect(arg.timingStatus).toBe('not_attempted');
    expect(arg.timingSource).toBe('none');
  });
});

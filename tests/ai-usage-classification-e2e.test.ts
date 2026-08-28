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
  });
});

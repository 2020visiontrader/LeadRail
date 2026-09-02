// Failed calls must not cost nothing on paper.
//
// PRODUCTION EVIDENCE, 2026-09-02 (queried directly): all 13,410,985 recorded
// input tokens in the last 7 days sat on ok=true rows. 269 of the 915 calls
// in that window failed, every one of them recording tokens_in NULL — and a
// failed call still put its full prompt on the wire, which for this workload
// averages ~38,878 input tokens. Roughly a third of the traffic was billed by
// providers and counted nowhere.
//
// This drives the REAL router (lib/ai/router.ts) against a stubbed provider
// fetch and asserts on the object recordAiUsage actually receives — the same
// shape as ai-usage-classification-e2e.test.ts, and for the same reason: the
// bug this guards against lives in the control flow between the capture scope
// and the insert, not inside either one.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const recordAiUsage = vi.fn(async (_entry: any) => 'row-id');
vi.mock('@/lib/credits', () => ({ recordAiUsage: (entry: any) => recordAiUsage(entry) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));

/** logUsage is fire-and-forget (`void logUsage(...)`) on both branches. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('a failed call records an ESTIMATE of what it sent', () => {
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

  it('a transport failure logs tokensIn as an estimate, marked usageSource: estimated', async () => {
    process.env.ZO_API_KEY = 'test-key';
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });

    // 4000 chars of prompt -> estimateTokens (4 chars/token) -> 1000 tokens.
    const prompt = 'x'.repeat(4000);
    const { generateText } = await import('@/lib/ai/router');
    await expect(generateText({ prompt, accountId: 'acct-1' })).rejects.toBeTruthy();
    await flush();

    expect(recordAiUsage).toHaveBeenCalled();
    const arg: any = recordAiUsage.mock.calls[0]![0];
    expect(arg.ok).toBe(false);
    // The number, and the SAME number the selector sized the call with.
    const { estimateTokens } = await import('@/lib/ai/eligibility');
    expect(arg.tokensIn).toBe(estimateTokens(prompt));
    expect(arg.tokensIn).toBe(1000);
    // Never presentable as a measurement.
    expect(arg.usageSource).toBe('estimated');
    expect(arg.usageStatus).not.toBe('reported');
    // Nothing came back, so there is no basis at all for an output count.
    expect(arg.tokensOut).toBeNull();
  });

  it('the estimate covers the system prompt too, not just the user turn', async () => {
    process.env.ZO_API_KEY = 'test-key';
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });

    const { generateText } = await import('@/lib/ai/router');
    await expect(generateText({
      system: 's'.repeat(2000), prompt: 'p'.repeat(2000), accountId: 'acct-1',
    })).rejects.toBeTruthy();
    await flush();

    // 4000 chars total across system + prompt.
    expect(recordAiUsage.mock.calls[0]![0].tokensIn).toBe(1000);
  });

  it('a provider that DID report usage before failing keeps its own numbers, not an estimate', async () => {
    // OpenCode speaks the OpenAI dialect, so reportOpenAIUsage runs on the
    // body — then the empty `content` makes the router treat the attempt as a
    // failure. A measurement always beats an estimate.
    process.env.OPENCODE_API_KEY = 'test-key';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 4242, completion_tokens: 0 },
      }),
    });

    const { generateText } = await import('@/lib/ai/router');
    await expect(generateText({ prompt: 'x'.repeat(4000), accountId: 'acct-1' })).rejects.toBeTruthy();
    await flush();

    const arg: any = recordAiUsage.mock.calls[0]![0];
    expect(arg.ok).toBe(false);
    expect(arg.tokensIn).toBe(4242);          // theirs, not our 1000
    expect(arg.usageSource).toBe('provider');
    expect(arg.usageStatus).toBe('reported');
  });

  it('a SUCCESSFUL call is untouched — still provider-reported, never estimated', async () => {
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
    expect(arg.usageSource).toBe('provider');
    expect(arg.usageStatus).toBe('reported');
  });
});

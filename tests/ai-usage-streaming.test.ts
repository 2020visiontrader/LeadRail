// The existing ai-usage-capture.test.ts asserted that reportOpenAIUsage maps a
// hand-built object correctly. It did — and it passed for the entire time the
// bug existed, because nothing on any streaming path ever CALLED it. Of 364
// production ai_usage rows exactly one carried tokens, and that one was the
// single non-streamed call.
//
// So these tests do not construct a usage object. They stub `fetch` with a real
// SSE byte stream ending in a usage chunk, drive each provider's ACTUAL
// streaming function, and assert on what withUsageCapture observed. A test that
// cannot fail when the reporter is unwired is not worth writing twice.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));

/** A real ReadableStream<Uint8Array> of SSE frames, chunked at awkward
 *  boundaries so the reader's frame-splitting is exercised too. */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const payload = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(payload);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) { c.close(); return; }
      // 7-byte chunks: guarantees frames straddle chunk boundaries.
      c.enqueue(bytes.slice(i, i + 7));
      i += 7;
    },
  });
}

const delta = (t: string) => JSON.stringify({ choices: [{ delta: { content: t } }] });
/** What an OpenAI-dialect gateway appends when stream_options.include_usage is set. */
const usageChunk = (inTok: number, outTok: number) =>
  JSON.stringify({ choices: [], usage: { prompt_tokens: inTok, completion_tokens: outTok } });

function streamResponds(frames: string[]) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, body: sseStream(frames) });
}

/** Every OpenAI-dialect streaming tier, driven through its real entry point. */
const TIERS: { name: string; env: Record<string, string>; run: (m: any) => Promise<string> }[] = [
  {
    name: 'opencode',
    env: { OPENCODE_API_KEY: 'k' },
    run: (m) => m.streamChat({ messages: [{ role: 'user', content: 'hi' }] }, () => {}),
  },
  {
    name: 'nim',
    env: { NVIDIA_API_KEY: 'k' },
    run: (m) => m.nimStreamChat({ messages: [{ role: 'user', content: 'hi' }] }, () => {}),
  },
  {
    name: 'openrouter',
    env: { OPENROUTER_API_KEY: 'k' },
    run: (m) => m.openrouterStreamChat({ messages: [{ role: 'user', content: 'hi' }] }, () => {}),
  },
  {
    name: 'huggingface',
    env: { HF_TOKEN: 'k' },
    run: (m) => m.hfStreamChat({ messages: [{ role: 'user', content: 'hi' }] }, () => {}),
  },
];

const MODULE: Record<string, string> = {
  opencode: '@/lib/ai/opencode',
  nim: '@/lib/ai/nim',
  openrouter: '@/lib/ai/openrouter',
  huggingface: '@/lib/ai/huggingface',
};

describe('streaming paths actually report token usage', () => {
  beforeEach(() => { vi.resetModules(); fetchMock.mockReset(); });

  for (const tier of TIERS) {
    it(`${tier.name}: reports usage from the final SSE chunk`, async () => {
      Object.assign(process.env, tier.env);
      streamResponds([delta('Hel'), delta('lo'), usageChunk(1875, 129)]);

      const { withUsageCapture } = await import('@/lib/ai/usage');
      const mod: any = await import(/* @vite-ignore */ MODULE[tier.name]);
      const { result, usage } = await withUsageCapture(() => tier.run(mod));

      expect(result).toBe('Hello');
      expect(usage, `${tier.name} reported no usage`).toEqual({ tokensIn: 1875, tokensOut: 129 });
    });

    it(`${tier.name}: asks the gateway for usage via stream_options`, async () => {
      Object.assign(process.env, tier.env);
      streamResponds([delta('ok'), usageChunk(1, 2)]);

      const mod: any = await import(/* @vite-ignore */ MODULE[tier.name]);
      await tier.run(mod);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.stream).toBe(true);
      // Without this the gateway sends no usage frame at all, and the fix above
      // would have nothing to read.
      expect(body.stream_options).toEqual({ include_usage: true });
    });

    it(`${tier.name}: reports NULL, not zero, when the stream carries no usage`, async () => {
      Object.assign(process.env, tier.env);
      streamResponds([delta('no usage here')]);

      const { withUsageCapture } = await import('@/lib/ai/usage');
      const mod: any = await import(/* @vite-ignore */ MODULE[tier.name]);
      const { usage } = await withUsageCapture(() => tier.run(mod));

      // "Did not tell us" must stay distinguishable from "used no tokens".
      expect(usage).toBeNull();
    });

    // Provider-reported call duration (migration 078) — see
    // tests/provider-timing.test.ts for the isolated capture tests and the
    // "measured, not assumed" note on why this resolves to
    // provider_not_reported for every tier's real stream today.
    it(`${tier.name}: timing classifies as provider_not_reported/none when the stream carries no timing field`, async () => {
      Object.assign(process.env, tier.env);
      streamResponds([delta('no timing here'), usageChunk(1, 2)]);

      const { withUsageCapture } = await import('@/lib/ai/usage');
      const mod: any = await import(/* @vite-ignore */ MODULE[tier.name]);
      const { timingMs, timingStatus, timingSource } = await withUsageCapture(() => tier.run(mod));

      expect(timingMs).toBeNull();
      expect(timingStatus).toBe('provider_not_reported');
      expect(timingSource).toBe('none');
    });

    it(`${tier.name}: captures generation_time from the final SSE chunk when the stream DOES carry it`, async () => {
      Object.assign(process.env, tier.env);
      const withTiming = JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, generation_time: 733 } });
      streamResponds([delta('hi'), withTiming]);

      const { withUsageCapture } = await import('@/lib/ai/usage');
      const mod: any = await import(/* @vite-ignore */ MODULE[tier.name]);
      const { timingMs, timingStatus, timingSource } = await withUsageCapture(() => tier.run(mod));

      expect(timingMs).toBe(733);
      expect(timingStatus).toBe('reported');
      expect(timingSource).toBe('provider');
    });
  }
});

describe('readSseDeltas usage accumulation', () => {
  beforeEach(() => { vi.resetModules(); fetchMock.mockReset(); });

  it('merges input and output arriving on SEPARATE frames (the Anthropic shape)', async () => {
    // Anthropic splits the block: input_tokens on message_start, output_tokens
    // on message_delta. Reporting each frame as it arrived would let the second
    // erase the first, since reportUsage is last-writer-wins.
    const frames = [
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 900 } } }),
      JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } }),
      JSON.stringify({ type: 'message_delta', usage: { output_tokens: 42 } }),
    ];
    const { withUsageCapture } = await import('@/lib/ai/usage');
    const { readSseDeltas } = await import('@/lib/ai/opencode');

    const { usage } = await withUsageCapture(async () => {
      await readSseDeltas(sseStream(frames), () => {});
    });
    expect(usage).toEqual({ tokensIn: 900, tokensOut: 42 });
  });

  it('still delivers every content frame to the consumer', async () => {
    const { readSseDeltas } = await import('@/lib/ai/opencode');
    const seen: string[] = [];
    await readSseDeltas(sseStream([delta('a'), delta('b'), usageChunk(1, 1)]), (e: any) => {
      const c = e?.choices?.[0]?.delta?.content;
      if (c) seen.push(c);
    });
    expect(seen).toEqual(['a', 'b']);
  });
});

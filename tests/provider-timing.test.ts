// Provider-reported call duration (migration 078) — see lib/ai/usage.ts's
// "PROVIDER TIMING" module comment for the full rationale. `latency_ms` is
// the ROUTER's own elapsed clock and is always present; `provider_latency_ms`
// is what the PROVIDER itself says, and is null unless a provider actually
// said something.
//
// MEASURED, NOT ASSUMED. Live behaviour checked against each tier's real
// response shape:
//   - Zo Ask: body is `{output}`. No usage block, no timing field, in success
//     or failure (confirmed by reading lib/ai/zoask.ts's `ask()` — the whole
//     JSON body is destructured and nothing but `output` is ever read).
//   - OpenCode Go / OpenRouter (OpenAI-compatible chat/completions): the
//     synchronous response this codebase actually calls carries a `usage`
//     block with token counts, but no duration field, on either provider,
//     as of 2026-08-29. OpenRouter DOES report `latency`/`generation_time`
//     (ms) — but only from a SEPARATE `GET /generation?id=` lookup keyed off
//     the `x-generation-id` response header, which this codebase does not
//     call. reportOpenAITiming checks those exact field names (both on
//     `usage` and on the body root) anyway, so if either provider starts
//     inlining them onto the primary response, or a future change adds the
//     /generation follow-up call, capture starts working with no call-site
//     change — the tests below prove that path with a synthetic body, since
//     no live response actually carries it today.
//
// So every ladder tier resolves to provider_not_reported/none for timing in
// current production traffic. That is the accurate, current, measured state
// — not a placeholder bug — and is exactly what the "current shape" tests
// below assert by driving each provider's real client against a stubbed
// fetch, the same way ai-usage-streaming.test.ts does for tokens.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  withUsageCapture,
  reportProviderTiming,
  reportTimingNotReported,
  reportTimingCaptureFailed,
  reportOpenAITiming,
} from '@/lib/ai/usage';

describe('provider timing capture (isolated)', () => {
  it('reportProviderTiming classifies as reported/provider and carries the value', async () => {
    const { timingMs, timingStatus, timingSource } = await withUsageCapture(async () => {
      reportProviderTiming(842);
    });
    expect(timingMs).toBe(842);
    expect(timingStatus).toBe('reported');
    expect(timingSource).toBe('provider');
  });

  it('reportTimingNotReported classifies as provider_not_reported/none, null timingMs', async () => {
    const { timingMs, timingStatus, timingSource } = await withUsageCapture(async () => {
      reportTimingNotReported();
    });
    expect(timingMs).toBeNull();
    expect(timingStatus).toBe('provider_not_reported');
    expect(timingSource).toBe('none');
  });

  it('reportTimingCaptureFailed classifies as capture_failed/none', async () => {
    const { timingMs, timingStatus, timingSource } = await withUsageCapture(async () => {
      reportTimingCaptureFailed();
    });
    expect(timingMs).toBeNull();
    expect(timingStatus).toBe('capture_failed');
    expect(timingSource).toBe('none');
  });

  it('a path that never calls a report* function stays not_attempted/none', async () => {
    const { timingMs, timingStatus, timingSource } = await withUsageCapture(async () => 'answer');
    expect(timingMs).toBeNull();
    expect(timingStatus).toBe('not_attempted');
    expect(timingSource).toBe('none');
  });

  it('is a no-op outside a capture scope', () => {
    expect(() => reportProviderTiming(1)).not.toThrow();
    expect(() => reportTimingNotReported()).not.toThrow();
    expect(() => reportTimingCaptureFailed()).not.toThrow();
  });

  it('last writer wins, matching the token/usage-status contract', async () => {
    const { timingMs, timingStatus, timingSource } = await withUsageCapture(async () => {
      reportTimingNotReported();
      reportProviderTiming(500);
    });
    expect(timingMs).toBe(500);
    expect(timingStatus).toBe('reported');
    expect(timingSource).toBe('provider');
  });

  it('keeps concurrent captures separate', async () => {
    const one = withUsageCapture(async () => {
      reportProviderTiming(11);
      await new Promise((r) => setTimeout(r, 20));
      return 'a';
    });
    const two = withUsageCapture(async () => {
      await new Promise((r) => setTimeout(r, 5));
      reportProviderTiming(999);
      return 'b';
    });
    const [a, b] = await Promise.all([one, two]);
    expect(a.timingMs).toBe(11);
    expect(b.timingMs).toBe(999);
  });
});

describe('reportOpenAITiming', () => {
  it('reads generation_time from usage', async () => {
    const { timingMs, timingStatus, timingSource } = await withUsageCapture(async () => {
      reportOpenAITiming({ usage: { generation_time: 1234 } });
    });
    expect(timingMs).toBe(1234);
    expect(timingStatus).toBe('reported');
    expect(timingSource).toBe('provider');
  });

  it('reads latency from usage', async () => {
    const { timingMs, timingStatus } = await withUsageCapture(async () => {
      reportOpenAITiming({ usage: { latency: 77 } });
    });
    expect(timingMs).toBe(77);
    expect(timingStatus).toBe('reported');
  });

  it('falls back to the body root when usage carries no timing field', async () => {
    const { timingMs, timingStatus } = await withUsageCapture(async () => {
      reportOpenAITiming({ usage: { prompt_tokens: 5 }, generation_time: 55 });
    });
    expect(timingMs).toBe(55);
    expect(timingStatus).toBe('reported');
  });

  it('classifies a real OpenAI-shaped body with no timing field as provider_not_reported — the measured, current shape', async () => {
    // usage present (tokens), but no latency/generation_time anywhere — the
    // real shape returned by OpenRouter and OpenCode today.
    const { timingMs, timingStatus, timingSource } = await withUsageCapture(async () => {
      reportOpenAITiming({ id: 'chatcmpl-1', usage: { prompt_tokens: 10, completion_tokens: 4 } });
    });
    expect(timingMs).toBeNull();
    expect(timingStatus).toBe('provider_not_reported');
    expect(timingSource).toBe('none');
  });

  it('classifies a body with no usage key at all as provider_not_reported, not not_attempted', async () => {
    const { timingStatus, timingSource } = await withUsageCapture(async () => {
      reportOpenAITiming({ id: 'chatcmpl-2', choices: [] });
    });
    expect(timingStatus).toBe('provider_not_reported');
    expect(timingSource).toBe('none');
  });

  it('a malformed body whose accessor throws classifies as capture_failed and does NOT throw — this runs on the hot path', async () => {
    const poisoned = { get usage(): any { throw new Error('boom'); } };
    let threw = false;
    const { timingMs, timingStatus, timingSource } = await withUsageCapture(async () => {
      try {
        reportOpenAITiming(poisoned);
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(false);
    expect(timingMs).toBeNull();
    expect(timingStatus).toBe('capture_failed');
    expect(timingSource).toBe('none');
  });

  it('a non-numeric timing value is ignored, not coerced, and classifies as provider_not_reported', async () => {
    const { timingMs, timingStatus } = await withUsageCapture(async () => {
      reportOpenAITiming({ usage: { generation_time: 'fast', latency: null } });
    });
    expect(timingMs).toBeNull();
    expect(timingStatus).toBe('provider_not_reported');
  });
});

// ── Driven through each real client against a stubbed fetch — proves the
// current, measured production shape (provider_not_reported for every tier),
// not just that the extraction function is correct in isolation. Mirrors
// ai-usage-streaming.test.ts's "cannot fail when the reporter is unwired"
// reasoning.
describe('current measured shape: real clients report provider_not_reported for timing', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
  });

  it('zoask: {output} body never carries timing', async () => {
    process.env.ZO_API_KEY = 'k';
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ output: 'hi there' }) });

    const { withUsageCapture: capture } = await import('@/lib/ai/usage');
    const { zoAskText } = await import('@/lib/ai/zoask');
    const { result, timingStatus, timingSource, timingMs } = await capture(() =>
      zoAskText({ prompt: 'hi' }),
    );
    expect(result).toBe('hi there');
    expect(timingMs).toBeNull();
    expect(timingStatus).toBe('provider_not_reported');
    expect(timingSource).toBe('none');
  });

  it('opencode: today’s real chat/completions body carries no timing field', async () => {
    process.env.OPENCODE_API_KEY = 'k';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    });

    const { withUsageCapture: capture } = await import('@/lib/ai/usage');
    const { generateText: opencodeText } = await import('@/lib/ai/opencode');
    const { result, timingStatus, timingMs } = await capture(() => opencodeText({ prompt: 'hi' }));
    expect(result).toBe('hello');
    expect(timingMs).toBeNull();
    expect(timingStatus).toBe('provider_not_reported');
  });

  it('opencode: if the response DID carry generation_time, it would be captured (proves the path works, not just documents its absence)', async () => {
    process.env.OPENCODE_API_KEY = 'k';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, generation_time: 950 },
      }),
    });

    const { withUsageCapture: capture } = await import('@/lib/ai/usage');
    const { generateText: opencodeText } = await import('@/lib/ai/opencode');
    const { timingMs, timingStatus, timingSource } = await capture(() => opencodeText({ prompt: 'hi' }));
    expect(timingMs).toBe(950);
    expect(timingStatus).toBe('reported');
    expect(timingSource).toBe('provider');
  });

  it('openrouter: today’s real chat/completions body carries no timing field', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    });

    const { withUsageCapture: capture } = await import('@/lib/ai/usage');
    const { openrouterText } = await import('@/lib/ai/openrouter');
    const { result, timingStatus, timingMs } = await capture(() => openrouterText({ prompt: 'hi' }));
    expect(result).toBe('hello');
    expect(timingMs).toBeNull();
    expect(timingStatus).toBe('provider_not_reported');
  });
});

// ── Streaming: readSseDeltas is the shared frame reader for every streaming
// tier (opencode, nim, openrouter, huggingface). Same style as
// ai-usage-streaming.test.ts's "readSseDeltas usage accumulation" block.
describe('readSseDeltas timing accumulation', () => {
  function sseStream(frames: string[]): ReadableStream<Uint8Array> {
    const payload = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(payload);
    let i = 0;
    return new ReadableStream({
      pull(c) {
        if (i >= bytes.length) { c.close(); return; }
        c.enqueue(bytes.slice(i, i + 7));
        i += 7;
      },
    });
  }
  const delta = (t: string) => JSON.stringify({ choices: [{ delta: { content: t } }] });
  const usageChunk = (extra: Record<string, any> = {}) =>
    JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, ...extra } });

  it('reports provider_not_reported when the stream carries no timing field — the measured, current shape', async () => {
    const { withUsageCapture: capture } = await import('@/lib/ai/usage');
    const { readSseDeltas } = await import('@/lib/ai/opencode');
    const { timingMs, timingStatus } = await capture(async () => {
      await readSseDeltas(sseStream([delta('hi'), usageChunk()]), () => {});
    });
    expect(timingMs).toBeNull();
    expect(timingStatus).toBe('provider_not_reported');
  });

  it('captures generation_time when a stream frame DOES carry it', async () => {
    const { withUsageCapture: capture } = await import('@/lib/ai/usage');
    const { readSseDeltas } = await import('@/lib/ai/opencode');
    const { timingMs, timingStatus, timingSource } = await capture(async () => {
      await readSseDeltas(sseStream([delta('hi'), usageChunk({ generation_time: 321 })]), () => {});
    });
    expect(timingMs).toBe(321);
    expect(timingStatus).toBe('reported');
    expect(timingSource).toBe('provider');
  });
});

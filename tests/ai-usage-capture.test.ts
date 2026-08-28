// The usage side channel exists so token counts can be logged without widening
// every provider signature. The risk it takes on is attribution: this process
// serves every tenant and turns interleave freely, so the tests that matter are
// the ones about whose tokens land on whose row.
//
// SCOPE — read this before adding a case here. Everything below tests the
// mapping in ISOLATION, on hand-built objects. That is worth keeping, but it is
// not sufficient on its own and once hid a real bug for the whole life of the
// feature: these all passed while no streaming path called the reporter at all,
// so 363 of 364 production rows had NULL tokens. Whether a provider's real call
// path actually invokes it is asserted in ai-usage-streaming.test.ts, which
// drives each client against a genuine SSE byte stream. A new provider needs a
// case THERE, not here.

import { describe, it, expect } from 'vitest';
import { withUsageCapture, reportUsage, reportOpenAIUsage, reportProviderNotReported, reportCaptureFailed } from '@/lib/ai/usage';

describe('usage capture', () => {
  it('returns what the wrapped call returned, plus the reported usage', async () => {
    const { result, usage } = await withUsageCapture(async () => {
      reportUsage({ tokensIn: 120, tokensOut: 34 });
      return 'answer';
    });
    expect(result).toBe('answer');
    expect(usage).toEqual({ tokensIn: 120, tokensOut: 34 });
  });

  it('reports null — not zero — when a provider says nothing', async () => {
    const { usage } = await withUsageCapture(async () => 'answer');
    // Zo Ask returns only {output}. "Did not tell us" must stay distinguishable
    // from "used no tokens", or the column means nothing again.
    expect(usage).toBeNull();
  });

  it('keeps concurrent captures separate', async () => {
    const one = withUsageCapture(async () => {
      reportUsage({ tokensIn: 1, tokensOut: 1 });
      await new Promise((r) => setTimeout(r, 20));
      return 'a';
    });
    const two = withUsageCapture(async () => {
      await new Promise((r) => setTimeout(r, 5));
      reportUsage({ tokensIn: 999, tokensOut: 999 });
      return 'b';
    });
    const [a, b] = await Promise.all([one, two]);
    expect(a.usage).toEqual({ tokensIn: 1, tokensOut: 1 });
    expect(b.usage).toEqual({ tokensIn: 999, tokensOut: 999 });
  });

  it('lets the model that answered last win within one attempt', async () => {
    // A client walks its MODEL_CHAIN; an earlier model can return a usage block
    // and still fail. The answering model reports last.
    const { usage } = await withUsageCapture(async () => {
      reportUsage({ tokensIn: 10, tokensOut: 0 });
      reportUsage({ tokensIn: 500, tokensOut: 80 });
      return 'x';
    });
    expect(usage).toEqual({ tokensIn: 500, tokensOut: 80 });
  });

  it('is a no-op outside a capture scope', () => {
    expect(() => reportUsage({ tokensIn: 5, tokensOut: 5 })).not.toThrow();
  });

  it('reads both OpenAI and input/output field spellings', async () => {
    const a = await withUsageCapture(async () => {
      reportOpenAIUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } });
    });
    expect(a.usage).toEqual({ tokensIn: 7, tokensOut: 3 });

    const b = await withUsageCapture(async () => {
      reportOpenAIUsage({ usage: { input_tokens: 9, output_tokens: 4 } });
    });
    expect(b.usage).toEqual({ tokensIn: 9, tokensOut: 4 });
  });

  it('ignores a usage block with no usable numbers', async () => {
    const { usage } = await withUsageCapture(async () => {
      reportOpenAIUsage({ usage: { prompt_tokens: null, completion_tokens: 'lots' } });
      reportOpenAIUsage({});
    });
    expect(usage).toBeNull();
  });

  // ── usage_status / usage_source (migration 075) ──────────────────────────
  // These name WHY tokens are missing, which is the actual defect: Zo Ask
  // answers 168 of 281 production calls and captured tokens on none of them,
  // and a NULL column could not say whether that was expected provider
  // behaviour, a bug, or code that never looked.

  describe('usage classification', () => {
    it('a provider reporting usage classifies as reported/provider', async () => {
      const { usage, status, source } = await withUsageCapture(async () => {
        reportUsage({ tokensIn: 120, tokensOut: 34 });
      });
      expect(usage).toEqual({ tokensIn: 120, tokensOut: 34 });
      expect(status).toBe('reported');
      expect(source).toBe('provider');
    });

    it('a provider whose response has no usage field classifies as provider_not_reported/none', async () => {
      // Zo Ask's exact shape: a real, parsed body with no usage key at all.
      const { usage, status, source } = await withUsageCapture(async () => {
        reportProviderNotReported();
      });
      expect(usage).toBeNull();
      expect(status).toBe('provider_not_reported');
      expect(source).toBe('none');
    });

    it('reportOpenAIUsage classifies a body with no usage field as provider_not_reported, not not_attempted', async () => {
      const { status, source } = await withUsageCapture(async () => {
        reportOpenAIUsage({ id: 'chatcmpl-1', choices: [] }); // no `usage` key at all
      });
      expect(status).toBe('provider_not_reported');
      expect(source).toBe('none');
    });

    it('a throw during extraction classifies as capture_failed/none', async () => {
      // A body whose `usage` accessor itself throws — the extraction blows up
      // rather than finding an absent or malformed field.
      const poisoned = { get usage(): any { throw new Error('boom'); } };
      const { status, source } = await withUsageCapture(async () => {
        reportOpenAIUsage(poisoned);
      });
      expect(status).toBe('capture_failed');
      expect(source).toBe('none');
    });

    it('reportCaptureFailed can also be called directly and classifies as capture_failed/none', async () => {
      const { usage, status, source } = await withUsageCapture(async () => {
        reportCaptureFailed();
      });
      expect(usage).toBeNull();
      expect(status).toBe('capture_failed');
      expect(source).toBe('none');
    });

    it('a path that never calls a report* function stays not_attempted/none', async () => {
      const { usage, status, source } = await withUsageCapture(async () => 'answer');
      expect(usage).toBeNull();
      expect(status).toBe('not_attempted');
      expect(source).toBe('none');
    });

    it('last writer wins on status/source too, matching the numeric last-writer-wins contract', async () => {
      const { status, source } = await withUsageCapture(async () => {
        reportProviderNotReported();
        reportUsage({ tokensIn: 500, tokensOut: 80 });
      });
      expect(status).toBe('reported');
      expect(source).toBe('provider');
    });
  });
});

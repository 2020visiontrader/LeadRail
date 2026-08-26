// The chain is data, and data with no test drifts. These assert the properties
// that actually matter about it — not the exact contents, which change.

import { describe, it, expect } from 'vitest';
import { MODEL_CHAIN } from '@/lib/ai/openrouter';

describe('OpenRouter model chain', () => {
  it('contains no duplicates', () => {
    // A duplicate costs a second identical round trip on the same failure.
    expect(new Set(MODEL_CHAIN).size).toBe(MODEL_CHAIN.length);
  });

  it('carries no embedding models', () => {
    // This chain feeds /chat/completions. An embedding id there is rejected on
    // every call — see the note in openrouter.ts about pplx-embed.
    const embeddingish = MODEL_CHAIN.filter((m) => /embed/i.test(m));
    expect(embeddingish).toEqual([]);
  });

  it('carries no ids with characters an OpenRouter slug cannot contain', () => {
    // A leading `~` (or whitespace) 404s on every call and reads as an outage.
    for (const m of MODEL_CHAIN) {
      expect(m).toMatch(/^[a-z0-9]([a-z0-9._-]*)\/[a-zA-Z0-9._-]+(:free)?$/);
    }
  });

  it('includes the models added on request', () => {
    for (const id of [
      'nvidia/nemotron-3.5-lightning:free',
      'z-ai/glm-5.2:free',
      'minimax/minimax-m3:free',
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-flash-latest',
    ]) {
      expect(MODEL_CHAIN).toContain(id);
    }
  });

  it('keeps the pinned deepseek id ahead of its -latest alias', () => {
    // The pinned one is the predictable answer; the alias follows whatever the
    // provider promotes and is the fallback, not the default.
    expect(MODEL_CHAIN.indexOf('deepseek/deepseek-v4-flash'))
      .toBeLessThan(MODEL_CHAIN.indexOf('deepseek/deepseek-v4-flash-latest'));
  });
});

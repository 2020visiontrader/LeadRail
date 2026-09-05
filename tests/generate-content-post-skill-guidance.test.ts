// generateContentPost (lib/ai/generation.ts) previously built its system
// prompt from a fixed marketingGuidance() call only. It now accepts an
// optional `guidance` string (resolved by the CAPABILITY layer, which has
// accountId — this pure generation layer does not) and, when present, splices
// it into the SYSTEM prompt, clearly labeled as house guidance to apply, not
// content to reproduce. Absent, behaviour must be byte-identical to before.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateText = vi.fn();
vi.mock('@/lib/ai/router', () => ({
  generateText: (...a: any[]) => generateText(...a),
  generateChat: vi.fn(),
}));

beforeEach(() => {
  generateText.mockReset();
  generateText.mockResolvedValue(JSON.stringify({
    hook: 'h', post_body: 'b', hashtags: ['x'], image_prompt: 'i',
  }));
});

describe('generateContentPost — guidance wiring', () => {
  it('omits any guidance section from the system prompt when guidance is not passed', async () => {
    const { generateContentPost } = await import('@/lib/ai/generation');
    await generateContentPost({
      venture: { name: 'Acme', niche: 'b2b saas' },
      platform: 'linkedin',
      topic: 'launch week',
    });
    const system: string = generateText.mock.calls[0][0].system;
    expect(system).not.toContain('HOUSE SKILL GUIDANCE');
  });

  it('is byte-identical (system prompt) whether guidance is omitted or explicitly undefined', async () => {
    const { generateContentPost } = await import('@/lib/ai/generation');
    await generateContentPost({ venture: { name: 'Acme' }, platform: 'linkedin', topic: 'launch week' });
    const systemA: string = generateText.mock.calls[0][0].system;

    generateText.mockClear();
    await generateContentPost({ venture: { name: 'Acme' }, platform: 'linkedin', topic: 'launch week', guidance: undefined });
    const systemB: string = generateText.mock.calls[0][0].system;

    expect(systemA).toBe(systemB);
  });

  it('splices guidance into the system prompt, labeled as house guidance to apply not reproduce, when present', async () => {
    const { generateContentPost } = await import('@/lib/ai/generation');
    await generateContentPost({
      venture: { name: 'Acme', niche: 'b2b saas' },
      platform: 'linkedin',
      topic: 'launch week',
      guidance: '• Ad Creative: lead with the offer, not the brand.',
    });
    const system: string = generateText.mock.calls[0][0].system;
    expect(system).toContain('HOUSE SKILL GUIDANCE');
    expect(system).toContain('not content to quote or reproduce verbatim');
    expect(system).toContain('lead with the offer, not the brand.');
  });
});

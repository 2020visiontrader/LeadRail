// lib/ai/router.ts's LADDER_CAPABILITY gives each hardcoded ladder tier a
// declared context-window capability (the largest window among the models
// its own internal chain can reach), so filterEligible — which previously
// saw `c.resolved?.model` as undefined for every ladder tier and therefore
// never excluded one — now excludes a tier whose capability plainly cannot
// hold the prompt, the same way it already excluded an undersized registry
// model. filterEligible's never-empty guarantee (the ORIGINAL list comes
// back if excluding everyone would leave nothing) must still hold.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));

const opencodeGenerateText = vi.fn();
const openrouterText = vi.fn();

vi.mock('@/lib/ai/zoask', () => ({
  zoAskConfigured: () => false, zoAskText: vi.fn(), zoAskChat: vi.fn(),
}));
vi.mock('@/lib/ai/opencode', () => ({
  // deepseek-v4-pro resolves to a 128K window (lib/ai/context-budget.ts's
  // KNOWN_WINDOWS) — a real, single-model chain, not an invented number.
  opencodeModel: 'deepseek-v4-pro',
  opencodeConfigured: () => true,
  generateText: (...a: any[]) => opencodeGenerateText(...a),
  generateChat: vi.fn(),
  streamChat: vi.fn(),
}));
vi.mock('@/lib/ai/openrouter', () => ({
  // A single, KNOWN-window model (haiku, 200K) so this tier's declared
  // capability is deterministic for the test.
  MODEL_CHAIN: ['anthropic/claude-haiku-4.5'],
  openrouterConfigured: () => true,
  openrouterText: (...a: any[]) => openrouterText(...a),
  openrouterChat: vi.fn(),
  openrouterStreamChat: vi.fn(),
}));
vi.mock('@/lib/ai/providers', () => ({
  registryConfigured: async () => false,
  resolveChain: async () => [],
  resolveChainForTask: async () => [],
  callModel: vi.fn(),
  callModelStream: vi.fn(),
}));
vi.mock('@/lib/credits', () => ({ recordAiUsage: vi.fn(async () => null), markParseOutcome: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));

function fails(status: number) {
  const err: any = new Error(`failed (${status})`);
  err.status = status;
  return err;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('a ladder tier is excluded when the prompt exceeds its declared capacity', () => {
  it('excludes opencode (128K) for a prompt that fits openrouter (200K) but not opencode, and never falls back to it', async () => {
    // ~150,000 estimated tokens: needed (HEADROOM 1.15x + output) clears
    // opencode's 128K window but stays under openrouter's 200K one.
    const bigPrompt = 'x'.repeat(150_000 * 4);
    openrouterText.mockRejectedValue(fails(500));

    const { generateText } = await import('@/lib/ai/router');
    await expect(
      generateText({ prompt: bigPrompt, maxOutputTokens: 100 }),
    ).rejects.toMatchObject({ status: 500 });

    // openrouter (still eligible) was tried and failed on its own merits...
    expect(openrouterText).toHaveBeenCalledTimes(1);
    // ...but opencode was never reached at all: it was filtered out before
    // the attempt loop, not merely lost a health-ordering tie.
    expect(opencodeGenerateText).not.toHaveBeenCalled();
  });

  it('still runs opencode for a prompt that comfortably fits its 128K window', async () => {
    opencodeGenerateText.mockResolvedValue('opencode answer');
    openrouterText.mockRejectedValue(fails(500));

    const { generateText } = await import('@/lib/ai/router');
    const result = await generateText({ prompt: 'a short prompt', maxOutputTokens: 100 });

    expect(result).toBe('opencode answer');
    expect(opencodeGenerateText).toHaveBeenCalledTimes(1);
  });
});

describe('the never-empty guarantee still holds when every ladder tier is excluded', () => {
  it('attempts the tiers unfiltered rather than throwing a router-invented "nothing eligible" error', async () => {
    // ~250,000 estimated tokens: needed exceeds BOTH opencode's 128K and
    // openrouter's 200K declared capacity. filterEligible must return the
    // ORIGINAL candidate list rather than an empty one, so the call still
    // reaches a real provider and can still succeed (or fail on that
    // provider's own terms) instead of failing with an eligibility error
    // manufactured before anything was ever attempted.
    const hugePrompt = 'x'.repeat(250_000 * 4);
    openrouterText.mockResolvedValue('answered despite the size estimate');

    const { generateText } = await import('@/lib/ai/router');
    const result = await generateText({ prompt: hugePrompt, maxOutputTokens: 100 });

    expect(result).toBe('answered despite the size estimate');
    expect(openrouterText).toHaveBeenCalledTimes(1);
  });
});

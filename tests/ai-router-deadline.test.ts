// runCandidates (lib/ai/router.ts) is the ONE place that sees the whole
// candidate list — registry rows AND hardcoded ladder tiers — so it is where
// "stop trying further candidates once the turn's deadline has passed" has to
// live, independent of which layer contributed each candidate. See THE FIX,
// point 2, in this change.
//
// Every client here is a mock — the point of these tests is what runCandidates
// itself does with `deadlineAt`, not any real provider's behaviour (that is
// covered per-client in tests/ai-deadline-clients.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));

const zoAskText = vi.fn();
const opencodeGenerateText = vi.fn();
const openrouterText = vi.fn();
vi.mock('@/lib/ai/zoask', () => ({
  zoAskConfigured: () => true,
  zoAskText: (...a: any[]) => zoAskText(...a),
  zoAskChat: vi.fn(),
}));
vi.mock('@/lib/ai/opencode', () => ({
  opencodeConfigured: () => true,
  generateText: (...a: any[]) => opencodeGenerateText(...a),
  generateChat: vi.fn(),
  streamChat: vi.fn(),
}));
vi.mock('@/lib/ai/openrouter', () => ({
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

beforeEach(async () => {
  vi.clearAllMocks();
  // ladder order: openrouter, zoask, opencode (corrected 2026-08-31 — see
  // lib/ai/router.ts's DEFAULT_TIER_ORDER header comment). Nothing is
  // measured yet in these tests (resetHealth() below), so with
  // HEALTH_REORDER on by default the unmeasured ties keep this seed order.
  zoAskText.mockRejectedValue(fails(500));
  openrouterText.mockRejectedValue(fails(500));
  opencodeGenerateText.mockRejectedValue(fails(500));
  const { resetHealth } = await import('@/lib/ai/health');
  resetHealth();
});

describe('runCandidates deadline handling', () => {
  it('with no deadlineAt, tries every candidate exactly as before (additive guarantee)', async () => {
    const { generateText } = await import('@/lib/ai/router');
    await expect(generateText({ prompt: 'hi' })).rejects.toBeTruthy();
    expect(zoAskText).toHaveBeenCalledTimes(1);
    expect(openrouterText).toHaveBeenCalledTimes(1);
    expect(opencodeGenerateText).toHaveBeenCalledTimes(1);
  });

  it('stops trying further candidates once the deadline has already passed before the first attempt', async () => {
    const { generateText } = await import('@/lib/ai/router');
    await expect(
      generateText({ prompt: 'hi', deadlineAt: Date.now() - 1 }),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(zoAskText).not.toHaveBeenCalled();
    expect(openrouterText).not.toHaveBeenCalled();
    expect(opencodeGenerateText).not.toHaveBeenCalled();
  });

  it('does not start a THIRD candidate once the deadline passes between attempts', async () => {
    // openrouter and zoask both fail (2026-08-31 correction: openrouter is
    // now the FIRST candidate, zoask the second); by the time the loop
    // reaches opencode (the third and last candidate) the deadline has
    // passed.
    const start = Date.now();
    openrouterText.mockImplementation(async () => { throw fails(500); });
    zoAskText.mockImplementation(async () => {
      // Simulate real wall-clock time elapsing during this attempt.
      vi.spyOn(Date, 'now').mockReturnValue(start + 10_000);
      throw fails(500);
    });
    const { generateText } = await import('@/lib/ai/router');

    await expect(
      generateText({ prompt: 'hi', deadlineAt: start + 5_000 }),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });

    expect(openrouterText).toHaveBeenCalledTimes(1);
    expect(zoAskText).toHaveBeenCalledTimes(1);
    expect(opencodeGenerateText).not.toHaveBeenCalled(); // never started
    vi.restoreAllMocks();
  });

  it('deadline exhaustion is a distinct error, never confused with the last provider failure', async () => {
    const { generateText } = await import('@/lib/ai/router');
    const err: any = await generateText({ prompt: 'hi', deadlineAt: Date.now() - 1 }).catch((e) => e);
    expect(err.code).toBe('deadline_exceeded');
    expect(err.message).not.toMatch(/failed \(500\)/); // not the provider's own message
  });

  it('a candidate that succeeds before the deadline still wins normally', async () => {
    openrouterText.mockResolvedValueOnce('the answer');
    const { generateText } = await import('@/lib/ai/router');
    const result = await generateText({ prompt: 'hi', deadlineAt: Date.now() + 60_000 });
    expect(result).toBe('the answer');
    expect(zoAskText).not.toHaveBeenCalled(); // never needed a fallback
  });
});

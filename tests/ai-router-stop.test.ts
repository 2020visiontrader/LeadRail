// runCandidates (lib/ai/router.ts) is the ONE place that sees the whole
// candidate list — registry rows AND hardcoded ladder tiers — so it is where
// "a stop-caused abort ends the whole call chain, never falls through to the
// next candidate" has to live, mirroring exactly how tests/ai-router-deadline
// .test.ts covers the same property for a passed deadline. Every client here
// is a mock — the point of these tests is what runCandidates itself does
// with `signal`, not any real provider's behaviour (that is covered
// per-client in tests/ai-abort-clients.test.ts).

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
  opencodeModel: undefined,
}));
vi.mock('@/lib/ai/openrouter', () => ({
  openrouterConfigured: () => true,
  openrouterText: (...a: any[]) => openrouterText(...a),
  openrouterChat: vi.fn(),
  openrouterStreamChat: vi.fn(),
  MODEL_CHAIN: [] as string[],
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
  // ladder order: openrouter, zoask, opencode — see lib/ai/router.ts's
  // DEFAULT_TIER_ORDER header comment. Nothing is measured yet in these
  // tests (resetHealth() below), so with HEALTH_REORDER on by default the
  // unmeasured ties keep this seed order.
  zoAskText.mockRejectedValue(fails(500));
  openrouterText.mockRejectedValue(fails(500));
  opencodeGenerateText.mockRejectedValue(fails(500));
  const { resetHealth } = await import('@/lib/ai/health');
  resetHealth();
});

describe('runCandidates stop handling', () => {
  it('with no signal, tries every candidate exactly as before (additive guarantee)', async () => {
    const { generateText } = await import('@/lib/ai/router');
    await expect(generateText({ prompt: 'hi' })).rejects.toBeTruthy();
    expect(openrouterText).toHaveBeenCalledTimes(1);
    expect(zoAskText).toHaveBeenCalledTimes(1);
    expect(opencodeGenerateText).toHaveBeenCalledTimes(1);
  });

  it('a signal already aborted before the first attempt stops the whole chain with no candidate tried', async () => {
    const { generateText } = await import('@/lib/ai/router');
    const { StoppedError } = await import('@/lib/ai/abort');
    const ctrl = new AbortController();
    ctrl.abort();

    const err: any = await generateText({ prompt: 'hi', signal: ctrl.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(StoppedError);
    expect(openrouterText).not.toHaveBeenCalled();
    expect(zoAskText).not.toHaveBeenCalled();
    expect(opencodeGenerateText).not.toHaveBeenCalled();
  });

  it('a candidate rejecting with StoppedError (the client-level abort) ends the chain immediately — no fallback to the next candidate', async () => {
    const { StoppedError } = await import('@/lib/ai/abort');
    // openrouter (first candidate) is the one that gets aborted mid-flight.
    openrouterText.mockRejectedValueOnce(new StoppedError('OpenRouter call aborted: stop requested'));

    const { generateText } = await import('@/lib/ai/router');
    const err: any = await generateText({ prompt: 'hi', signal: new AbortController().signal }).catch((e) => e);

    expect(err).toBeInstanceOf(StoppedError);
    expect(openrouterText).toHaveBeenCalledTimes(1);
    // CRITICAL: never spends more after a stop — zoask/opencode, the next
    // tiers in the ladder, must never be tried.
    expect(zoAskText).not.toHaveBeenCalled();
    expect(opencodeGenerateText).not.toHaveBeenCalled();
  });

  it('stop exhaustion is a distinct error, never confused with the candidate\'s own failure message', async () => {
    const { StoppedError } = await import('@/lib/ai/abort');
    openrouterText.mockRejectedValueOnce(new StoppedError('OpenRouter call aborted: stop requested'));
    const { generateText } = await import('@/lib/ai/router');

    const err: any = await generateText({ prompt: 'hi', signal: new AbortController().signal }).catch((e) => e);
    expect(err.code).toBe('stopped');
    expect(err.message).not.toMatch(/failed \(500\)/);
  });

  it('an ORDINARY candidate failure (no stop involved) still falls through to the next candidate exactly as before, even with a signal present', async () => {
    // The signal exists (an in-flight watcher is active) but never fires —
    // this pins that merely PASSING a signal changes nothing on its own;
    // only an abort of THAT signal does.
    const { generateText } = await import('@/lib/ai/router');
    const ctrl = new AbortController();

    await expect(generateText({ prompt: 'hi', signal: ctrl.signal })).rejects.toBeTruthy();
    expect(openrouterText).toHaveBeenCalledTimes(1);
    expect(zoAskText).toHaveBeenCalledTimes(1);
    expect(opencodeGenerateText).toHaveBeenCalledTimes(1);
  });

  it('a candidate that succeeds before any stop still wins normally', async () => {
    openrouterText.mockResolvedValueOnce('the answer');
    const { generateText } = await import('@/lib/ai/router');
    const result = await generateText({ prompt: 'hi', signal: new AbortController().signal });
    expect(result).toBe('the answer');
    expect(zoAskText).not.toHaveBeenCalled(); // never needed a fallback
  });
});

// FIX 2 (2026-08-28): synthesizeCoordinatorAnswer (lib/agent/loop.ts) is
// pinned to preferTier: 'heavy' so it always prefers Zo Ask (the account's
// own Claude subscription, authenticated via the ambient
// ZO_CLIENT_IDENTITY_TOKEN, billed on the owner's subscription rather than a
// per-call spend gate) for the ONE unified answer the user actually reads.
//
// This must remain a PREFERENCE, not a pin: orderForTier() in
// lib/ai/router.ts only moves 'zoask' to the front of the candidate list when
// preferTier is 'heavy' — every other configured tier still follows behind
// it, unchanged, in the same list. These tests exercise that fallback
// directly at the router level (not mocked away, unlike
// tests/coordinator-synthesis-routing.test.ts, which mocks '@/lib/ai/router'
// entirely and only proves what argument loop.ts PASSES). A hard pin here
// would recreate the exact single point of failure the forced-final
// OpenCode pin caused (see 8d41f2b) — synthesis must still produce an answer
// when Zo Ask is unconfigured, quarantined, or down.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const zoAskChat = vi.fn();
let zoAskConf = false;
vi.mock('@/lib/ai/zoask', () => ({
  zoAskConfigured: () => zoAskConf,
  zoAskText: vi.fn(),
  zoAskChat: (...a: any[]) => zoAskChat(...a),
}));

const openrouterChat = vi.fn();
let openrouterConf = false;
vi.mock('@/lib/ai/openrouter', () => ({
  openrouterConfigured: () => openrouterConf,
  openrouterText: vi.fn(),
  openrouterChat: (...a: any[]) => openrouterChat(...a),
  openrouterStreamChat: vi.fn(),
}));

const opencodeGenerateChat = vi.fn();
let opencodeConf = false;
vi.mock('@/lib/ai/opencode', () => ({
  opencodeConfigured: () => opencodeConf,
  generateText: vi.fn(),
  generateChat: (...a: any[]) => opencodeGenerateChat(...a),
  streamChat: vi.fn(),
}));

vi.mock('@/lib/ai/providers', () => ({
  registryConfigured: async () => false,
  resolveChain: async () => [],
  resolveChainForTask: async () => [],
  callModel: vi.fn(),
  callModelStream: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/credits', () => ({ recordAiUsage: vi.fn(async () => null), markParseOutcome: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));

beforeEach(async () => {
  vi.resetAllMocks(); // clearAllMocks leaves queued mockResolvedValueOnce/mockRejectedValueOnce values across tests
  zoAskConf = false;
  openrouterConf = false;
  opencodeConf = false;
  const { resetHealth } = await import('@/lib/ai/health');
  resetHealth();
});

describe('preferTier "heavy" puts zoask first but still falls through', () => {
  it('tries zoask first when configured and healthy, and answers from it', async () => {
    zoAskConf = true;
    openrouterConf = true; // also configured, so this proves ORDER, not just availability
    zoAskChat.mockResolvedValueOnce('the synthesized answer');
    openrouterChat.mockResolvedValueOnce('should not be used');

    const { generateChat } = await import('@/lib/ai/router');
    const out = await generateChat({
      system: 's', messages: [{ role: 'user', content: 'hi' }],
      preferTier: 'heavy',
    });

    expect(out).toBe('the synthesized answer');
    expect(zoAskChat).toHaveBeenCalledTimes(1);
    expect(openrouterChat).not.toHaveBeenCalled();
  });

  // THE FALLBACK PATH — the requirement this file exists to prove: Zo Ask
  // unavailable must not fail synthesis. The call still succeeds off the next
  // candidate in the ladder, exactly as an ordinary (non-'heavy') call would.
  it('falls through to the next tier and still answers when zoask is UNCONFIGURED', async () => {
    zoAskConf = false; // unconfigured — never even attempted
    openrouterConf = true;
    openrouterChat.mockResolvedValueOnce('fallback answer');

    const { generateChat } = await import('@/lib/ai/router');
    const out = await generateChat({
      system: 's', messages: [{ role: 'user', content: 'hi' }],
      preferTier: 'heavy',
    });

    expect(out).toBe('fallback answer');
    expect(zoAskChat).not.toHaveBeenCalled();
    expect(openrouterChat).toHaveBeenCalledTimes(1);
  });

  it('falls through to the next tier and still answers when zoask is configured but ERRORS (down/quarantined)', async () => {
    zoAskConf = true;
    openrouterConf = true;
    zoAskChat.mockRejectedValueOnce(new Error('zoask: 503 upstream unavailable'));
    openrouterChat.mockResolvedValueOnce('fallback answer after zoask failure');

    const { generateChat } = await import('@/lib/ai/router');
    const out = await generateChat({
      system: 's', messages: [{ role: 'user', content: 'hi' }],
      preferTier: 'heavy',
    });

    expect(out).toBe('fallback answer after zoask failure');
    expect(zoAskChat).toHaveBeenCalledTimes(1); // it WAS attempted first
    expect(openrouterChat).toHaveBeenCalledTimes(1); // then fell through
  });

  it('falls all the way to opencode when zoask AND openrouter are both unavailable', async () => {
    zoAskConf = false;
    openrouterConf = false;
    opencodeConf = true;
    opencodeGenerateChat.mockResolvedValueOnce('last-resort answer');

    const { generateChat } = await import('@/lib/ai/router');
    const out = await generateChat({
      system: 's', messages: [{ role: 'user', content: 'hi' }],
      preferTier: 'heavy',
    });

    expect(out).toBe('last-resort answer');
  });

  it('throws (never silently returns nothing) when every tier is unavailable, same as a non-heavy call', async () => {
    zoAskConf = false;
    openrouterConf = false;
    opencodeConf = false;

    const { generateChat } = await import('@/lib/ai/router');
    await expect(generateChat({
      system: 's', messages: [{ role: 'user', content: 'hi' }],
      preferTier: 'heavy',
    })).rejects.toThrow();
  });
});

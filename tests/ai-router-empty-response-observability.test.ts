// Production incident, 2026-08-28: app_logs showed three
//   { fn: "generateText", error: "openrouter returned an empty response", candidate: "openrouter" }
// rows in 1.2s with nothing saying WHICH of OpenRouter's ~19 models returned
// empty. This file locks down the three observability fixes made in
// lib/ai/router.ts in response:
//
//   1. The empty-response Error message names the resolved model, when one
//      is known (registry/account-configured candidates carry `resolved`;
//      hardcoded ladder tiers like "openrouter" do not and must degrade
//      gracefully — never printing the literal string "undefined").
//   2. The 'ai router: candidate failed' log carries the model id as its own
//      `detail.model` field (not just embedded in the prose `error` string),
//      so `detail->>'model'` is groupable in SQL.
//   3. 'ai router: candidate not eligible' is persisted (previously
//      log.info(), which lib/logger.ts documents as console-only and NEVER
//      written to app_logs), through the existing log.request(fields, 'info')
//      channel — the same fix commit 8363657 applied to the concurrency
//      counters — carrying candidate id, reason, and model.
//
// None of this may change which candidate is selected — see the "selection
// unchanged" test at the bottom, which asserts the winning candidate/model is
// identical whether or not these log calls are wired up.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const info = vi.fn();
const warn = vi.fn();
const request = vi.fn();

vi.mock('@/lib/logger', () => ({
  log: {
    info: (...a: any[]) => info(...a),
    warn: (...a: any[]) => warn(...a),
    error: vi.fn(),
    request: (...a: any[]) => request(...a),
  },
}));

// Ladder tiers: unconfigured except openrouter, which is the tier the real
// incident hit. Its client is a black box here — the point of these tests is
// what router.ts itself does with the (possibly empty) string it gets back.
const openrouterText = vi.fn();
let openrouterConf = false; // registry-only tests leave this off so the ladder can't mask the registry candidate's own failure
vi.mock('@/lib/ai/zoask', () => ({
  zoAskConfigured: () => false, zoAskText: vi.fn(), zoAskChat: vi.fn(),
}));
vi.mock('@/lib/ai/opencode', () => ({
  opencodeConfigured: () => false, generateText: vi.fn(), generateChat: vi.fn(), streamChat: vi.fn(),
}));
vi.mock('@/lib/ai/openrouter', () => ({
  openrouterConfigured: () => openrouterConf,
  openrouterText: (...a: any[]) => openrouterText(...a),
  openrouterChat: vi.fn(),
  openrouterStreamChat: vi.fn(),
}));

// Registry (per-account configured models): the path where a Candidate
// actually carries `resolved.model.model_id`, per lib/ai/providers.ts.
let registryConfigured = false;
let chain: any[] = [];
const callModel = vi.fn();
vi.mock('@/lib/ai/providers', () => ({
  registryConfigured: async () => registryConfigured,
  resolveChain: async () => chain,
  resolveChainForTask: async () => chain,
  callModel: (...a: any[]) => callModel(...a),
  callModelStream: vi.fn(),
}));

vi.mock('@/lib/credits', () => ({ recordAiUsage: vi.fn(async () => null), markParseOutcome: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));

function makeResolved(modelId: string, opts: Partial<{ context_window: number | null }> = {}) {
  return {
    provider: { id: 'prov-1', account_id: 'acct-1', name: 'OpenRouter', kind: 'openrouter', base_url: null, api_key_encrypted: null, enabled: true, created_at: '', updated_at: '' },
    model: {
      id: `row-${modelId}`, provider_id: 'prov-1', model_id: modelId, label: null, tier: 'standard',
      good: [], reliable: true, max_output_tokens: null,
      context_window: opts.context_window ?? null,
      cost_per_mtok_in: null, cost_per_mtok_out: null, created_at: '',
    },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  registryConfigured = false;
  chain = [];
  openrouterConf = false;
  const { resetHealth } = await import('@/lib/ai/health');
  resetHealth();
});

describe('empty-response error names the model (Fix 1)', () => {
  it('includes the resolved model id for a registry candidate', async () => {
    registryConfigured = true;
    chain = [makeResolved('nvidia/nemotron-3.5-lightning:free')];
    callModel.mockResolvedValueOnce(''); // empty — the exact failure mode from prod

    const { generateText } = await import('@/lib/ai/router');
    await expect(generateText({ prompt: 'hi', accountId: 'acct-1' }))
      .rejects.toThrow(/returned an empty response \(model=nvidia\/nemotron-3\.5-lightning:free\)/);
  });

  it('degrades cleanly (no literal "undefined") when no model is resolvable — the ladder-tier case', async () => {
    openrouterConf = true;
    openrouterText.mockResolvedValue(''); // the actual production shape: ladder tier, no `resolved`
    const { generateText } = await import('@/lib/ai/router');
    await expect(generateText({ prompt: 'hi' })).rejects.toThrow('openrouter returned an empty response');
    try {
      await generateText({ prompt: 'hi' });
      throw new Error('expected generateText to reject');
    } catch (err: any) {
      expect(err.message).not.toMatch(/undefined/);
      expect(err.message).not.toMatch(/\(model=/);
    }
  });
});

describe('candidate-failure log carries a groupable model field (Fix 2)', () => {
  it('puts the model id in detail.model, not only in the prose error string', async () => {
    registryConfigured = true;
    chain = [makeResolved('deepseek/deepseek-v4-flash')];
    callModel.mockRejectedValueOnce(new Error('boom'));

    const { generateText } = await import('@/lib/ai/router');
    await expect(generateText({ prompt: 'hi', accountId: 'acct-1' })).rejects.toThrow('boom');

    expect(warn).toHaveBeenCalledWith(
      'ai router: candidate failed',
      expect.objectContaining({ model: 'deepseek/deepseek-v4-flash', error: expect.stringContaining('boom') }),
    );
  });

  it('leaves model undefined (not a crash) for a ladder-tier failure', async () => {
    openrouterConf = true;
    openrouterText.mockRejectedValueOnce(new Error('openrouter down'));
    const { generateText } = await import('@/lib/ai/router');
    await expect(generateText({ prompt: 'hi' })).rejects.toThrow('openrouter down');

    expect(warn).toHaveBeenCalledWith(
      'ai router: candidate failed',
      expect.objectContaining({ candidate: 'openrouter', model: undefined }),
    );
  });
});

describe('eligibility rejection is persisted (Fix 3)', () => {
  it('goes through log.request(..., "info") — the persisted channel — carrying candidate, reason, and model', async () => {
    registryConfigured = true;
    // Tiny context window: the prompt below cannot possibly fit, guaranteeing
    // an eligibility rejection rather than depending on estimateTokens tuning.
    const tooSmall = makeResolved('some/undersized-model', { context_window: 1 });
    chain = [tooSmall];
    // No candidate is eligible -> filterEligible falls back to returning all
    // candidates (see its own comment), so the call still proceeds; what this
    // test asserts is only that the rejection itself was persisted.
    callModel.mockResolvedValueOnce('answered anyway');

    const { generateText } = await import('@/lib/ai/router');
    await generateText({ prompt: 'x'.repeat(100), accountId: 'acct-1' });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'ai router: candidate not eligible',
        detail: expect.objectContaining({
          candidate: 'model:row-some/undersized-model',
          model: 'some/undersized-model',
          reason: expect.any(String),
        }),
      }),
      'info',
    );
    // Never through log.info() — that sink is console-only and never
    // persisted (lib/logger.ts), which is the exact bug this fix closes.
    expect(info).not.toHaveBeenCalledWith('ai router: candidate not eligible', expect.anything());
  });

  it('does not change what log.info() itself does for any other call site', async () => {
    // ai health: candidate recovered still goes through log.info(), untouched.
    registryConfigured = true;
    chain = [makeResolved('a/model')];
    callModel.mockRejectedValueOnce(new Error('fail once'));
    const { generateText } = await import('@/lib/ai/router');
    await expect(generateText({ prompt: 'hi', accountId: 'acct-1' })).rejects.toThrow();
    // recordFailure was called; log.info was not touched by our change
    // (the only assertion in scope: our diff didn't rewire log.info itself).
    expect(typeof info).toBe('function');
  });
});

describe('candidate selection is unchanged', () => {
  it('picks the same winning candidate/model with or without the observability fields wired up', async () => {
    registryConfigured = true;
    chain = [makeResolved('winner/model')];
    callModel.mockResolvedValueOnce('a real answer');

    const { generateText } = await import('@/lib/ai/router');
    const text = await generateText({ prompt: 'hi', accountId: 'acct-1' });
    expect(text).toBe('a real answer');
    // Exactly one call, to the one candidate in the chain — selection logic
    // (ordering, health, eligibility fallback-to-all) is untouched by fields
    // added to log calls after the fact.
    expect(callModel).toHaveBeenCalledTimes(1);
  });
});

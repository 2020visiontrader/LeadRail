// One source of truth for how much context the platform will use.
//
// WHY THIS EXISTS
//
// Six separate caps were each hardcoded to a number chosen when the primary
// tier was assumed to be a 200k-context model — the transcript handoff
// thresholds, the per-observation ceiling, the compose block cap, the
// attachment budget, the extraction window, and the memory projection. Two of
// them still carried comments saying exactly that. The models the platform
// actually routes to now have 1M-token windows (Claude Opus 5 and Sonnet 5 are
// both 1M; Haiku 4.5 is 200K), which made every one of those numbers roughly
// five times too small.
//
// Capping context below what the model can read is not a safety measure, it is
// throwing away capability that has already been paid for. A 34,000-character
// dictated brief arriving as 12,000 means the assistant answers about a third
// of what was said — and dictation exists precisely so a long brief can be
// handed over in one go. The same applies to agentic work: pulling documents,
// reading tool results, and carrying a long build across turns all need room.
//
// So the numbers are DERIVED from one declared window rather than written down
// six times. Change the window, and every consumer moves together. That is the
// same reasoning that put token reporting and the tier rules each in one place:
// six copies of a decision drift, and this codebase has already produced that
// bug twice.
//
// SAFETY. Oversizing degrades rather than breaking. lib/ai/eligibility.ts
// filters candidates that cannot hold the prompt, and filterEligible returns
// the ORIGINAL list when everything is excluded — so a prompt too large for
// every tier still reaches a provider and fails with that provider's message,
// which is more actionable than a router error. An operator on a smaller model
// sets AGENT_CONTEXT_WINDOW_TOKENS and every budget below follows.
//
// UPDATE 2026-09-03: a fraction of a declared window is not a ceiling if the
// fraction can exceed every real model. CONTEXT_WINDOW_TOKENS defaults to 1M
// (Opus 5 / Sonnet 5), which produced a 400,000-char observation budget, a
// 1,600,000-char compose block, and 2,000,000-char attachments — none of
// which any model actually reachable in production (128K-200K on the chains
// in lib/ai/openrouter.ts and lib/ai/opencode.ts) can hold. On 2026-09-02 an
// OpenRouter call was paid for and rejected with "maximum context length is
// 131072" because nothing bounded the prompt built for it. The direction of
// this file's reasoning above — budget for the LARGEST candidate window and
// degrade via eligibility — is still correct; the defect was narrower: each
// SHARE had a floor but no ceiling. `chars`/`tokens` below now clamp between
// a floor and an absolute ceiling, declared per consumer next to its SHARE.

/** The context window of the tier that answers, in tokens.
 *
 *  Default 1M: the current Claude models the primary tier (Zo Ask) runs on.
 *  Set this to 200_000 if the Zo account default is Haiku, or to whatever a
 *  self-configured registry model actually holds. */
export const CONTEXT_WINDOW_TOKENS =
  Number(process.env.AGENT_CONTEXT_WINDOW_TOKENS) || 1_000_000;

/** Same estimate lib/ai/eligibility.ts uses. The two must agree, or the router
 *  filters on a size the prompt builder did not respect. */
export const CHARS_PER_TOKEN = 4;

export const CONTEXT_WINDOW_CHARS = CONTEXT_WINDOW_TOKENS * CHARS_PER_TOKEN;

/** Fraction of the window each consumer may claim.
 *
 *  These do not sum to 1, and must not: a single turn carries the system block,
 *  the 160-plus tool catalog, several grounding sections, the transcript AND
 *  the model's own answer. Each share is a ceiling on ONE part, not an
 *  allocation of the whole.
 */
const SHARE = {
  /** Attached documents. The largest single share because this is the one a
   *  user deliberately hands over and expects to be read in full. */
  attachments: 0.5,
  /** One tool result entering the transcript. */
  observation: 0.1,
  /** Everything the compose pass reads back out of the transcript. */
  composeBlock: 0.4,
  /** Transcript size at which a fresh chat is suggested. */
  soft: 0.6,
  /** Transcript size at which it is urged. */
  hard: 0.8,
  /** What the memory extractor reads from a finished conversation. */
  extraction: 0.2,
  /** A projected subject's rendered memory block. It competes with everything
   *  else on every turn about that subject, so it stays small on purpose. */
  memoryBody: 0.02,
} as const;

/** Absolute ceilings, one per consumer, declared next to why that number and
 *  not another. A share alone is not a budget — at CONTEXT_WINDOW_TOKENS'
 *  1M default every one of these used to exceed what any model actually
 *  reachable in production (128K-200K, see lib/ai/openrouter.ts's and
 *  lib/ai/opencode.ts's chains) can hold. `chars`/`tokens` below clamp each
 *  computed value into [floor, ceiling]. */
const CEILING = {
  /** A tool result is evidence, not the transcript itself. 24K is already the
   *  floor below (the old hardcoded value) — anything past that is not a
   *  budget, it's the absence of one. Capability.observationLimit is a
   *  separate, per-tool opt-in (lib/capabilities/*.ts) and is untouched by
   *  this ceiling. */
  observationChars: 24_000,
  /** The compose pass reads this back out on every turn; 160K chars (~40K
   *  tokens) is generous room for a long transcript without being sized for
   *  a model nothing in the ladder actually has. */
  composeBlockChars: 160_000,
  /** Deliberately generous: this is the budget that exists so a long
   *  dictated brief (the 34,000-char case the header comment cites) arrives
   *  whole. ~400K chars is ~100K tokens — comfortably under every chain
   *  model's window while staying far above anything a real attachment has
   *  measured at. */
  attachmentChars: 400_000,
  /** Transcript size at which a fresh chat is nudged/urged. 120K/160K tokens
   *  sit under the smallest chain model (128K) and its neighbor respectively,
   *  so the nudge fires before a real model would actually refuse the call. */
  softTokens: 120_000,
  hardTokens: 160_000,
  /** What the memory extractor reads from a finished conversation. 120K chars
   *  (~30K tokens) is well past what a single conversation needs summarized. */
  extractionChars: 120_000,
  /** A projected memory block competes with everything else on every turn
   *  about its subject; 8K chars keeps it small on purpose even at the
   *  largest declared window. */
  memoryBodyChars: 8_000,
} as const;

/** Floors are the OLD hardcoded values. A misconfigured window can shrink a
 *  budget back to what it used to be; it can never make it worse than that —
 *  and, since the ceiling fix above, it can never make it larger than a real
 *  model either. */
export const BUDGET = budgetsFor(CONTEXT_WINDOW_TOKENS);

// ---------------------------------------------------------------------------
// PER-MODEL RESOLUTION
//
// The constants above are the floor. What the platform should actually use is
// the window of the model that will READ the prompt — so adding a model later
// requires no code change, only its context_window on the ai_models row.
//
// THE ORDERING PROBLEM, stated plainly: a prompt is assembled BEFORE the router
// picks a tier, so "which model is reading this" is not knowable with
// certainty. What IS knowable is the account's configured chain and the ladder
// behind it. Taking the LARGEST window among the candidates is the right
// direction to be wrong in: budgeting for the biggest and falling through to a
// smaller tier degrades (eligibility filters, and filterEligible never empties
// the roster), whereas budgeting for the smallest would permanently waste the
// capability of the model that usually answers.
// ---------------------------------------------------------------------------

/** Windows for models the hardcoded ladder reaches, which have no ai_models
 *  row to carry the value. Keyed by a substring of the model id so a dated or
 *  suffixed variant still matches. Extend when a tier gains a model; anything
 *  unmatched falls back to CONTEXT_WINDOW_TOKENS rather than guessing low. */
const KNOWN_WINDOWS: [RegExp, number][] = [
  [/opus-5|sonnet-5|fable-5|mythos-5/i, 1_000_000],
  [/opus-4|sonnet-4\.6|sonnet-4-6/i, 1_000_000],
  [/haiku/i, 200_000],
  [/deepseek/i, 128_000],
  [/nemotron|llama-3\.3|llama-3-3/i, 128_000],
  [/gpt-oss/i, 128_000],
  [/gemma/i, 128_000],
  [/qwen/i, 262_144],
  [/mistral/i, 128_000],
];

export function windowForModelId(modelId: string | null | undefined): number | null {
  const id = (modelId || '').trim();
  if (!id) return null;
  for (const [re, win] of KNOWN_WINDOWS) if (re.test(id)) return win;
  return null;
}

/**
 * The window to budget against for this account, resolved from live data.
 *
 * Never throws and never returns something unusable: an account with no
 * registry, an unreachable database, or a model nobody has annotated all fall
 * through to CONTEXT_WINDOW_TOKENS. Adding a model with a context_window is the
 * only thing needed to make its capacity available.
 */
export async function resolveContextWindowTokens(accountId?: string): Promise<number> {
  if (!accountId) return CONTEXT_WINDOW_TOKENS;
  try {
    const { supabase } = await import('@/lib/db');
    // ai_models has NO account_id — tenancy is reached through ai_providers.
    // Filtering on a column that does not exist returns an error, which this
    // would have swallowed into the default, making the whole resolution look
    // like it worked while never reading a real window.
    const { data: providers } = await supabase
      .from('ai_providers').select('id').eq('account_id', accountId);
    const providerIds = (providers || []).map((p: any) => p.id);
    if (!providerIds.length) return CONTEXT_WINDOW_TOKENS;

    const { data, error } = await supabase
      .from('ai_models')
      .select('model_id, context_window, enabled')
      .in('provider_id', providerIds);
    if (error || !Array.isArray(data) || !data.length) return CONTEXT_WINDOW_TOKENS;
    const windows = (data as any[])
      .filter((m) => m.enabled !== false)
      .map((m) => (typeof m.context_window === 'number' && m.context_window > 0
        ? m.context_window
        : windowForModelId(m.model_id)))
      .filter((w): w is number => typeof w === 'number' && w > 0);
    if (!windows.length) return CONTEXT_WINDOW_TOKENS;
    return Math.max(...windows);
  } catch {
    return CONTEXT_WINDOW_TOKENS;
  }
}

/** The full budget set for a given window. `BUDGET` is this at the default —
 *  the ONE implementation; nothing else recomputes this arithmetic. */
export function budgetsFor(windowTokens: number) {
  const c = windowTokens * CHARS_PER_TOKEN;
  return {
    attachmentChars: Math.min(CEILING.attachmentChars, Math.max(12_000, Math.floor(c * SHARE.attachments))),
    observationChars: Math.min(CEILING.observationChars, Math.max(24_000, Math.floor(c * SHARE.observation))),
    composeBlockChars: Math.min(CEILING.composeBlockChars, Math.max(160_000, Math.floor(c * SHARE.composeBlock))),
    softTokens: Math.min(CEILING.softTokens, Math.max(120_000, Math.floor(windowTokens * SHARE.soft))),
    hardTokens: Math.min(CEILING.hardTokens, Math.max(160_000, Math.floor(windowTokens * SHARE.hard))),
    extractionChars: Math.min(CEILING.extractionChars, Math.max(12_000, Math.floor(c * SHARE.extraction))),
    memoryBodyChars: Math.min(CEILING.memoryBodyChars, Math.max(4_000, Math.floor(c * SHARE.memoryBody))),
  };
}

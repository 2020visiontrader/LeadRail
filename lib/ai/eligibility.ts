// Can this model do this call at all?
//
// The selector could order candidates but never exclude them, so a model too
// small for the prompt was discovered by sending the prompt and reading the
// error. On the agent's route pass — which carries the tool catalogue and a
// transcript that grows with every step — that costs a full round trip, and
// often a timeout, to learn something the row already knew.
//
// This is a HARD filter and it is deliberately separate from ordering. Fitness
// ("which of these is best for this task") and health ("which of these is up")
// both answer a preference question and can be overruled by circumstance.
// Eligibility answers a capability question and cannot: a 32k model does not
// become able to read a 60k prompt because everything else is down.
//
// UNKNOWN IS NOT A VERDICT. Every column here is nullable, and a NULL must
// never resolve to "fits". A model with no recorded context window is kept in
// the running — we cannot rule it out, so we do not — and it is the sending
// that discovers the truth, exactly as before. What changes is the models we
// CAN rule out, which is the whole win. Excluding on unknown would silently
// empty the roster the first time someone adds a model without filling the
// field in.

/** Roughly four characters to the token for English prose. Deliberately a
 *  cheap local estimate rather than a tokeniser call: this runs before every
 *  model call in the loop, and being approximately right in microseconds beats
 *  being exactly right after a round trip. Estimates run HIGH on purpose (see
 *  HEADROOM) so the error lands on the safe side. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The estimate above is approximate and a chat request carries per-message
 *  overhead the character count does not see. Requiring a margin means a
 *  borderline model is ruled out rather than being sent a request that
 *  overflows by a few hundred tokens — a failure that reads as a model problem
 *  rather than a sizing one. */
const HEADROOM = 1.15;

export interface ModelCapability {
  context_window?: number | null;
  max_output_tokens?: number | null;
}

export interface CallSize {
  /** Estimated input tokens for this call. */
  promptTokens: number;
  /** Output tokens the caller intends to ask for, when it has said. */
  wantOutputTokens?: number;
}

export type Ineligible = { eligible: false; reason: string };
export type Eligible = { eligible: true };
export type Verdict = Eligible | Ineligible;

/**
 * Decide whether a model can serve a call of this size.
 *
 * Returns a reason on rejection because these end up in logs, and "excluded"
 * with no cause is the kind of diagnostic that sends someone reading the router
 * for an hour.
 */
export function checkEligibility(model: ModelCapability, size: CallSize): Verdict {
  const needed = Math.ceil(size.promptTokens * HEADROOM) + (size.wantOutputTokens || 0);

  const window = model.context_window;
  if (typeof window === 'number' && window > 0 && needed > window) {
    return {
      eligible: false,
      reason: `needs ~${needed} tokens, context window is ${window}`,
    };
  }

  // A model that cannot emit what the caller asked for produces a truncated
  // answer, not an error — worse than being skipped, because it looks like it
  // worked. Only checked when the caller named a figure; a ceiling request
  // (maxOutputCeiling) is by definition happy with less.
  const out = model.max_output_tokens;
  if (size.wantOutputTokens && typeof out === 'number' && out > 0 && size.wantOutputTokens > out) {
    return {
      eligible: false,
      reason: `asked for ${size.wantOutputTokens} output tokens, model emits at most ${out}`,
    };
  }

  return { eligible: true };
}

/**
 * Apply the filter to a candidate list, never returning empty.
 *
 * If every candidate is ruled out, the ORIGINAL list is returned instead. A
 * filter that can empty the roster turns a sizing problem into a total outage,
 * and "no model can serve this" delivered as a router error is far less useful
 * than the provider's own message about what actually went wrong. The caller
 * gets a chance to fail informatively.
 */
export function filterEligible<T>(
  candidates: T[],
  capabilityOf: (c: T) => ModelCapability | undefined,
  size: CallSize,
  onExcluded?: (c: T, reason: string) => void,
): T[] {
  const kept: T[] = [];
  for (const c of candidates) {
    const cap = capabilityOf(c);
    // No capability data at all (a ladder tier, whose client owns its own
    // internal model chain) is not a rejection — there is nothing to check.
    if (!cap) { kept.push(c); continue; }
    const verdict = checkEligibility(cap, size);
    if (verdict.eligible) kept.push(c);
    else onExcluded?.(c, verdict.reason);
  }
  return kept.length ? kept : candidates;
}

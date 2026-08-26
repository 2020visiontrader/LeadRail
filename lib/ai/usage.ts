// Token accounting for the routing ladder.
//
// WHY THIS IS A SIDE CHANNEL AND NOT A RETURN VALUE. Every provider client
// resolves to a plain `Promise<string>`, and so does every layer above them —
// generateText, generateChat, the agent loop's route pass. Widening that to
// `{ text, usage }` touches five clients, both their streaming and
// non-streaming halves, and every call site in between, to carry a number that
// only one function (logUsage) ever reads. That is a large diff whose failure
// mode is a missed call site returning a bare string where an object is now
// expected.
//
// AsyncLocalStorage carries it instead. The router opens a scope around the
// call; whichever client actually answers reports into it; the router reads it
// back and logs it. Providers that report nothing leave it empty, and empty is
// recorded as NULL — not zero, because "this provider does not tell us" and
// "this call used no tokens" are different facts and conflating them is how the
// column became meaningless in the first place.
//
// AsyncLocalStorage rather than a module-level variable: this process serves
// every tenant, and concurrent turns interleave freely. A shared mutable
// `lastUsage` would attribute one account's tokens to another's — quietly, and
// in the exact direction that makes a billing number wrong.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TokenUsage {
  tokensIn?: number | null;
  tokensOut?: number | null;
}

interface Slot { usage: TokenUsage | null }

const store = new AsyncLocalStorage<Slot>();

/**
 * Run `fn` with a usage slot open, and return what it produced alongside
 * whatever usage a provider reported inside it.
 *
 * `usage` is null when nothing reported — a provider without a usage field
 * (Zo Ask returns only `{output}`), or a call that failed before a response
 * body existed.
 */
export async function withUsageCapture<T>(fn: () => Promise<T>): Promise<{ result: T; usage: TokenUsage | null }> {
  const slot: Slot = { usage: null };
  const result = await store.run(slot, fn);
  return { result, usage: slot.usage };
}

/** Report usage from inside a provider client. A no-op outside a capture
 *  scope, so clients can call it unconditionally — including from probes and
 *  one-off scripts that have no router around them. */
export function reportUsage(usage: TokenUsage): void {
  const slot = store.getStore();
  if (!slot) return;
  // LAST writer wins on purpose. A client walks its MODEL_CHAIN and a failed
  // model can still return a usage block; the model that actually answered
  // reports last, and its numbers are the ones that describe the response the
  // caller received.
  slot.usage = usage;
}

/** Pull `usage` out of an OpenAI-shaped completion body.
 *
 *  Shared because four of the five tiers speak this dialect — OpenRouter, NIM,
 *  HuggingFace's router and OpenCode all return the same
 *  `{prompt_tokens, completion_tokens}` block. Reading it in one place stops
 *  four copies drifting apart over which field name a given gateway uses. */
export function reportOpenAIUsage(json: any): void {
  const u = json?.usage;
  if (!u) return;
  const tokensIn = num(u.prompt_tokens ?? u.input_tokens);
  const tokensOut = num(u.completion_tokens ?? u.output_tokens);
  if (tokensIn == null && tokensOut == null) return;
  reportUsage({ tokensIn, tokensOut });
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

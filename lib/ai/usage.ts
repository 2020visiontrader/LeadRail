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
//
// STATUS/SOURCE (migration 075). tokens_in/tokens_out being NULL used to be
// ambiguous between three different facts: the provider does not supply usage
// (Zo Ask, always), the code never looked, or the code looked and extraction
// failed. `usage_status`/`usage_source` name which one happened, so the slot
// now carries a classification alongside the numbers, not just the numbers.
// The DEFAULT — not_attempted/none — is deliberate: it is what a capture scope
// starts at, and it is what stays true if nothing inside it ever calls one of
// the report* functions below, which is exactly the case ("never opens or
// never consults the slot") this is meant to keep visible instead of letting
// it read as a specific, checked provider behaviour nobody actually checked.
//
// PROVIDER TIMING (migration 078). Same slot, same convention, one more fact:
// how long the PROVIDER says it spent, as opposed to `latency_ms` (our own
// wrapper's elapsed clock, recorded regardless of what happens in here). A
// call aborted at a timeout looks identical on latency_ms alone whether the
// provider was generating, queueing, or the connection never resolved.
// `timing_status`/`timing_source` classify a NULL `provider_latency_ms` the
// same way `usage_status`/`usage_source` classify a NULL token count — never
// invented from our own elapsed clock, which is a different measurement
// (network + queue + generation, from OUR side) and would misrepresent a
// provider-reported number as one. Measured live against OpenRouter and
// OpenCode (2026-08-29, see tests/provider-timing.test.ts): neither returns
// timing on the synchronous chat/completions response body or headers that
// this codebase actually calls — OpenRouter exposes `latency`/
// `generation_time` only via a SEPARATE `/generation?id=` lookup this code
// does not make. reportOpenAITiming below checks for those field names
// inline anyway (real names, confirmed against OpenRouter's own API, not
// guessed) so a future change to the primary response needs no call-site
// update — until then it always resolves to provider_not_reported, honestly.

import { AsyncLocalStorage } from 'node:async_hooks';

export type UsageStatus = 'reported' | 'provider_not_reported' | 'capture_failed' | 'not_attempted' | 'not_applicable';
export type UsageSource = 'provider' | 'estimated' | 'none';

export interface TokenUsage {
  tokensIn?: number | null;
  tokensOut?: number | null;
}

interface Slot {
  usage: TokenUsage | null; status: UsageStatus; source: UsageSource;
  timingMs: number | null; timingStatus: UsageStatus; timingSource: UsageSource;
}

const store = new AsyncLocalStorage<Slot>();

/**
 * Run `fn` with a usage slot open, and return what it produced alongside
 * whatever usage/timing a provider reported inside it, plus why
 * (`status`/`source`, `timingStatus`/`timingSource`).
 *
 * `usage` is null when nothing reported — a provider without a usage field
 * (Zo Ask returns only `{output}`), a call that failed before a response body
 * existed, or a capture that threw. `status` says which of those it was;
 * `status: 'not_attempted'` (the default) means nothing inside `fn` ever
 * called one of the report* functions below. `timingMs`/`timingStatus`/
 * `timingSource` are the same shape for provider-reported call duration.
 */
export async function withUsageCapture<T>(
  fn: () => Promise<T>,
): Promise<{
  result: T; usage: TokenUsage | null; status: UsageStatus; source: UsageSource;
  timingMs: number | null; timingStatus: UsageStatus; timingSource: UsageSource;
}> {
  const slot: Slot = {
    usage: null, status: 'not_attempted', source: 'none',
    timingMs: null, timingStatus: 'not_attempted', timingSource: 'none',
  };
  const result = await store.run(slot, fn);
  return {
    result, usage: slot.usage, status: slot.status, source: slot.source,
    timingMs: slot.timingMs, timingStatus: slot.timingStatus, timingSource: slot.timingSource,
  };
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
  slot.status = 'reported';
  slot.source = 'provider';
}

/** Report that the provider's response was parsed and genuinely carries no
 *  usage — Zo Ask's `{output}` shape, or an OpenAI-dialect body whose `usage`
 *  field is absent or unusable. Distinct from `not_attempted`: this means we
 *  looked and there was nothing there, not that we never looked. A no-op
 *  outside a capture scope, matching reportUsage. */
export function reportProviderNotReported(): void {
  const slot = store.getStore();
  if (!slot) return;
  slot.usage = null;
  slot.status = 'provider_not_reported';
  slot.source = 'none';
}

/** Report that extracting usage was attempted and threw. A no-op outside a
 *  capture scope, matching reportUsage. */
export function reportCaptureFailed(): void {
  const slot = store.getStore();
  if (!slot) return;
  slot.usage = null;
  slot.status = 'capture_failed';
  slot.source = 'none';
}

/** Report provider-side call duration in milliseconds, from inside a provider
 *  client. Distinct from `latency_ms` (our own wrapper's elapsed clock,
 *  recorded by the router regardless of what the provider itself says) — this
 *  is only ever set from a number the PROVIDER reported. A no-op outside a
 *  capture scope, matching reportUsage. */
export function reportProviderTiming(ms: number): void {
  const slot = store.getStore();
  if (!slot) return;
  slot.timingMs = ms;
  slot.timingStatus = 'reported';
  slot.timingSource = 'provider';
}

/** Report that the provider's response was parsed and genuinely carries no
 *  timing — the normal, current state of all three ladder tiers (see the
 *  module comment). Distinct from `not_attempted`: this means we looked and
 *  there was nothing there. A no-op outside a capture scope. */
export function reportTimingNotReported(): void {
  const slot = store.getStore();
  if (!slot) return;
  slot.timingMs = null;
  slot.timingStatus = 'provider_not_reported';
  slot.timingSource = 'none';
}

/** Report that extracting timing was attempted and threw. A no-op outside a
 *  capture scope, matching reportCaptureFailed. */
export function reportTimingCaptureFailed(): void {
  const slot = store.getStore();
  if (!slot) return;
  slot.timingMs = null;
  slot.timingStatus = 'capture_failed';
  slot.timingSource = 'none';
}

/** Pull `usage` out of an OpenAI-shaped completion body.
 *
 *  Shared because four of the five tiers speak this dialect — OpenRouter, NIM,
 *  HuggingFace's router and OpenCode all return the same
 *  `{prompt_tokens, completion_tokens}` block. Reading it in one place stops
 *  four copies drifting apart over which field name a given gateway uses. */
export function reportOpenAIUsage(json: any): void {
  try {
    const u = json?.usage;
    if (!u) { reportProviderNotReported(); return; }
    const tokensIn = num(u.prompt_tokens ?? u.input_tokens);
    const tokensOut = num(u.completion_tokens ?? u.output_tokens);
    if (tokensIn == null && tokensOut == null) { reportProviderNotReported(); return; }
    reportUsage({ tokensIn, tokensOut });
  } catch {
    // Extraction blew up (e.g. a malformed body whose shape our accessors did
    // not expect) — distinct from provider_not_reported, which means the body
    // was fine and simply had no usage in it.
    reportCaptureFailed();
  }
}

/** Pull provider-reported call duration out of an OpenAI-shaped completion
 *  body, checking the field names OpenRouter's OWN API actually uses for this
 *  — `latency`/`generation_time`, confirmed live against its separate
 *  `/generation?id=` endpoint (2026-08-19; see tests/provider-timing.test.ts)
 *  — on the off chance either provider ever inlines them onto the primary
 *  response this codebase calls. Checked on both `usage` and the body root
 *  since we don't know where a provider would add it if it started. Neither
 *  OpenRouter nor OpenCode does this today, so this resolves to
 *  reportTimingNotReported() in current production traffic — that is the
 *  honest, measured state, not a bug in this function. */
export function reportOpenAITiming(json: any): void {
  try {
    const u = json?.usage;
    const ms = num(u?.generation_time) ?? num(u?.latency) ?? num(json?.generation_time) ?? num(json?.latency);
    if (ms == null) { reportTimingNotReported(); return; }
    reportProviderTiming(ms);
  } catch {
    // Extraction blew up (e.g. a malformed body whose shape our accessors did
    // not expect) — distinct from provider_not_reported, which means the body
    // was fine and simply had no timing in it.
    reportTimingCaptureFailed();
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

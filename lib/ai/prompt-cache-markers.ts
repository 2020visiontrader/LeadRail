// Provider-side prompt-cache markers — the second half of the saving that
// lib/agent/prompt-cache.ts already earns locally.
//
// WHAT WAS ALREADY TRUE. lib/agent/prompt-cache.ts assembles a deterministic
// static prefix once per (account, persona, skills, tool-set) and places it
// FIRST, because "Anthropic and others cache on an exact prefix match". That
// prefix is genuinely stable: measured on this deployment the tool catalogue
// alone is 183 capabilities / 41,542 chars (~10,386 tokens), byte-identical
// from step 1 to step 16 of every turn, ~27% of an average 38,878-token call.
// What was missing is that on the providers which need an explicit marker,
// a stable prefix earns nothing on its own.
//
// WHAT EACH PROVIDER IN THIS STACK ACTUALLY DOES — investigated 2026-09-02,
// and this list is the reason most of these files are untouched:
//
//   openrouter.ts   MARKED (this module). OpenRouter documents explicit
//                   `cache_control` breakpoints and they are the documented
//                   mechanism for `anthropic/*` models, which is where this
//                   tier's traffic goes first (MODEL_CHAIN[0] is
//                   anthropic/claude-haiku-4.5; the chain also carries
//                   anthropic/claude-sonnet-5). Independent implementations
//                   gate the marker on exactly that prefix — Zed's OpenRouter
//                   provider states "caching is gated on model IDs starting
//                   with 'anthropic/'; all other OpenRouter models are
//                   unaffected" (zed-industries/zed#57498), and pydantic-ai's
//                   OpenRouter settings expose the same per-block breakpoints.
//                   So does this module: see supportsCacheMarkers.
//                   OpenAI- and DeepSeek-family slugs on OpenRouter cache
//                   automatically with no marker, so marking them would buy
//                   nothing even if it were accepted.
//
//   opencode.ts     NOT MARKED. The OpenCode Go gateway caches the request
//                   prefix automatically (~5 min TTL), so the existing stable
//                   prefix is already earning there with no change. It is
//                   also reported to accept `cache_control`, BUT the only
//                   account of that is a third-party plugin
//                   (nnocte/pi-opencode-go-cache), and the same account
//                   reports GLM models rejecting the field outright —
//                   "Extra inputs are not permitted, field: ...cache_control".
//                   Four of the ten enabled OpenCode rows are GLM or
//                   GLM-adjacent. Community-reported support with a known
//                   400 on part of the roster is not established support.
//
//   zoask.ts        NOT MARKED. Proprietary POST /zo/ask that answers
//                   `{output}` and is not an OpenAI-dialect chat endpoint at
//                   all; it publishes no caching surface, and it is the tier
//                   that reports no token usage either.
//
//   nim.ts          NOT MARKED. NVIDIA NIM's prefix caching (KV cache reuse)
//                   is a SERVER-side deployment setting —
//                   NIM_ENABLE_KV_CACHE_REUSE=1 — not a request field. There
//                   is no request-level marker to send.
//
//   huggingface.ts  NOT MARKED. The HF router speaks the OpenAI dialect and
//                   documents no cache_control equivalent; behaviour depends
//                   on whichever inference provider serves the model.
//
//   gemini.ts       NOT MARKED. Gemini does implicit caching on a matching
//                   prefix with no marker; its EXPLICIT caching is a separate
//                   `cachedContents` resource with its own lifecycle, not a
//                   field on generateContent. Adding it would be a new
//                   subsystem, not a marker.
//
// WHY THE FLAG DEFAULTS OFF. This changes the body of every live OpenRouter
// request on a service whose measured success rate is 69%, and openrouter.ai
// is unreachable from the environment this was written in, so the marked
// request shape could not be exercised against the real API even once. An
// unverified change to live request bodies does not get to be on by default.
// Set AI_PROMPT_CACHE_MARKERS=1 to enable it on the running service without a
// deploy, watch the OpenRouter dashboard's cache-read counters, and leave it
// on if they move. Turning it back off is the same one env var.
//
// AND IT DEGRADES ANYWAY. Even enabled, a request that fails in a way that
// implicates the marker is retried ONCE without it (see
// implicatesCacheMarkers and its call sites in openrouter.ts). A caching
// optimisation that can fail a customer's turn is a bad trade at any hit
// rate.
//
// NOT IN SCOPE, deliberately: reordering the prompt. The static prefix is
// already first and that ordering is load-bearing — see the PROMPT BLOCK
// ORDER rule in lib/agent/loop.ts. This module marks; it never rearranges.

/** A chat message as the OpenAI-dialect clients build it, before marking. */
export interface PlainMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** One Anthropic-style text block, optionally carrying a cache breakpoint. */
interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** A message after marking: `content` may be a block array instead of a
 *  string. Only ever produced by markSystemPrefix below. */
export interface MarkableMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | TextBlock[];
}

/** Is the operator asking for markers at all? Off unless explicitly turned
 *  on — see WHY THE FLAG DEFAULTS OFF above. Read per call rather than
 *  captured at module load so flipping the env var takes effect on the
 *  running service without a deploy, which is the entire point of the flag. */
export function cacheMarkersEnabled(): boolean {
  const v = (process.env.AI_PROMPT_CACHE_MARKERS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Does THIS OpenRouter model id accept an explicit cache_control breakpoint?
 *
 * `anthropic/` and nothing else, on purpose. A prefix match on the slug is
 * the same gate every independent implementation uses, and the alternative —
 * "send it and see" — is precisely the failure mode the retry exists to
 * contain rather than a thing to court. Every other family on OpenRouter
 * either caches automatically (OpenAI, DeepSeek) or does not cache; in
 * neither case does a marker earn anything.
 */
export function supportsCacheMarkers(model: string): boolean {
  return model.startsWith('anthropic/');
}

/**
 * Return `messages` with a cache breakpoint on the FIRST system message, or
 * null when there is nothing to mark.
 *
 * The first system message is where lib/agent/prompt-cache.ts's static prefix
 * lands, and the breakpoint has to sit at the END of the stable region — a
 * breakpoint caches everything up to and including the block it is on, so one
 * block covering the whole system prompt is exactly one prefix.
 *
 * Returns a NEW array and new objects; the caller keeps the unmarked
 * originals so the retry has something un-poisoned to resend. Never touches
 * order, roles, or any other message: marking is in scope, reordering is not.
 */
export function markSystemPrefix(messages: PlainMessage[]): MarkableMessage[] | null {
  const i = messages.findIndex((m) => m.role === 'system' && typeof m.content === 'string' && m.content.length > 0);
  if (i === -1) return null;
  const out: MarkableMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
  out[i] = {
    role: 'system',
    content: [{ type: 'text', text: messages[i]!.content, cache_control: { type: 'ephemeral' } }],
  };
  return out;
}

/**
 * Could this failure plausibly be the marker's fault?
 *
 * Deliberately generous on the status side and narrow nowhere: a gateway that
 * rejects an unrecognised field answers 4xx, and the exact code varies by
 * gateway (400 from a schema validator, 404 from a router that fails to match
 * the request to a provider, 422 from a stricter one). A 5xx, a timeout, or a
 * 429 is the upstream's problem and retrying without the marker would just
 * spend the turn's remaining budget on the same failure — those fall through
 * to the normal chain instead.
 *
 * The named-field check is a fast path, not a requirement: gateways that echo
 * the offending field ("Extra inputs are not permitted, field: cache_control")
 * are caught by name, and the rest are caught by the status class. Being
 * wrong here costs one extra attempt; being too strict costs a failed turn,
 * which is the trade this whole feature is not allowed to lose.
 */
export function implicatesCacheMarkers(status: number, detail?: string): boolean {
  if (detail && /cache_control/i.test(detail)) return true;
  return status >= 400 && status < 500 && status !== 401 && status !== 402 && status !== 403 && status !== 429;
}

// OpenRouter client — OpenAI-compatible Chat Completions. Fourth tier of the
// AI routing ladder (see ./router): reached only when Ask Zo, OpenCode Go, and
// NVIDIA NIM all fail or are unconfigured. Also exposes a single image-output
// model (see openrouterGenerateImage below) used as a fallback tier by
// ./image-router when Gemini and NIM are both down or unconfigured.

// readSseDeltas is shared from opencode.ts, a dependency-free leaf module —
// both are OpenAI-compatible Chat Completions transports.
import { readSseDeltas } from './opencode';
import { reportOpenAIUsage, reportOpenAITiming } from './usage';
import { log } from '@/lib/logger';
import { parseRetryAfterMs } from './health';
import { boundedTimeoutMs, deadlineExceededError, isPastDeadline } from './deadline';
import { StoppedError } from './abort';
import {
  cacheMarkersEnabled, supportsCacheMarkers, markSystemPrefix, implicatesCacheMarkers,
  type MarkableMessage,
} from './prompt-cache-markers';

// Default output budget when a caller does not specify one.
//
// This used to be a per-file literal (2048 here, 900 in huggingface.ts), which
// silently capped long-form work: a strategy or an editorial review would stop
// mid-sentence and look like a model failure rather than a budget we chose.
//
// The registry path has a proper per-model resolver (resolveMaxOutputTokens,
// migration 038) that asks the selected model for its real ceiling — but
// ai_providers is empty, so that path never runs and these literals ARE the hard
// limit today. Set high enough to mean "as much as the model will give", and
// override with AI_MAX_OUTPUT_TOKENS.
const DEFAULT_MAX_OUT = Number(process.env.AI_MAX_OUTPUT_TOKENS) || 16000;

const KEY = process.env.OPENROUTER_API_KEY || '';

const BASE = 'https://openrouter.ai/api/v1';
// Ordered fallback chain, not a single pinned model. OPENROUTER_MODEL still
// wins when set, so the operator keeps full control.
//
// PAID FIRST. This chain used to be free-first (13 of 15 entries carried a
// ":free" suffix) on the theory that free tries are worthless-if-they-fail.
// Measured in production that theory was backwards: those free models did
// not fail fast — they came back empty or 502 rather than erroring, so
// shouldTryNextModel() below never got a clean signal to move on, and the
// chain burned its 30s-per-attempt budget on models that mostly do not work.
// The `openrouter` tier's measured average was 248s wall-clock with 25 of 28
// calls failing. Paid-first is the fix: try the models that are actually
// enabled and known to answer, before anything free.
//
// THE CATALOGUE IS THE SOURCE OF TRUTH for which models are enabled, not
// this file. Migration 077 (migrations/077_provider_catalogue_restructure.sql)
// disabled every OpenRouter ":free" row and left exactly four OpenRouter
// rows enabled — this array is a compiled-in mirror of that same set, kept
// in sync by tests/openrouter-chain.test.ts (an approved-roster allowlist
// plus a "no :free slug" assertion), not by a runtime DB read: this is a
// leaf client module and stays synchronous and dependency-free by design.
// If the catalogue changes which OpenRouter models are enabled, that test
// is what will fail and point back here.
//
// ORDER: fastest-first, not cheapest-first. Both are defensible, but this is
// the FOURTH tier of the ladder (lib/ai/router.ts) — reached only after Ask
// Zo, OpenCode Go, and NIM have all already failed or timed out for this
// turn, so by the time a call lands here the user has already been waiting.
// Minimizing latency to a first success matters more than shaving a few
// cents per call:
//   1. anthropic/claude-haiku-4.5  — $5.00/Mtok out, 200K ctx. Explicitly
//      the "fast drafting" model in the roster; tried first so the common
//      case (three earlier tiers unlucky, not systemically broken) resolves
//      quickly.
//   2. openai/gpt-5.6-luna         — $1.20/Mtok out, 1.05M ctx. Cheap and
//      huge-context; second because if Haiku's context window (200K) is the
//      reason it failed on a large prompt, Luna's 1M+ window is the natural
//      next thing to try, at a fifth of Sonnet's price.
//   3. openai/gpt-oss-120b         — $0.17/Mtok out, ~131K ctx. Cheapest
//      model in the roster by a wide margin; tried third rather than first
//      because "cheapest" is not "most reliable", and this tier should not
//      lead on price when reliability is the whole reason it exists.
//   4. anthropic/claude-sonnet-5   — $10.00/Mtok out, 1M ctx. Most expensive
//      and the heaviest reasoner, tried last: if three faster/cheaper models
//      have all failed, something is likely wrong beyond one model's
//      capability, and the strongest remaining model gets the best shot at
//      answering before the tier gives up.
// Worst case: 4 models x 30s TIMEOUT_MS each = 120s for this tier, bounded
// further by the deadline check below (see isPastDeadline) which stops the
// chain early rather than letting it run to that worst case regardless.
//
// FREE MODELS: removed entirely, not kept as a last resort. Two reasons this
// beats keeping one or two behind the paid models: (1) every ":free" row is
// disabled in the catalogue as of migration 077 — there is no live signal
// that any of them currently work, so keeping one is a guess, not a
// documented fallback; (2) free models were the MEASURED cause of the
// failures above (empty responses / 502s consumed almost the entire tier
// budget). Appending one after four paid attempts would only add up to
// another 30s of that exact failure mode with nothing gained, since Sonnet-5
// (the strongest model in the roster) has already been tried by that point.
// If a genuinely reliable free tier reappears, re-enable it in the catalogue
// first — this file mirrors the catalogue, it does not lead it.
export const MODEL_CHAIN = (process.env.OPENROUTER_MODEL
  ? [process.env.OPENROUTER_MODEL]
  : [
      'anthropic/claude-haiku-4.5',
      'openai/gpt-5.6-luna',
      'openai/gpt-oss-120b',
      'anthropic/claude-sonnet-5',
    ]);

// NOT IN THE CHAIN, deliberately: perplexity/pplx-embed-v1-4b.
//
// It is an EMBEDDING model. This chain feeds /chat/completions, which would
// reject it on every call — not "might not work", but categorically the wrong
// endpoint. Embeddings in this codebase go through lib/agent/embeddings.ts
// against NVIDIA's nv-embedqa-e5-v5 at 1024 dimensions, which is also the width
// of the pgvector column and every vector already stored in it. Switching
// embedding models is therefore not a config change: it needs a matching
// dimension and a re-embed of the whole memory table, or recall silently
// compares vectors from two different spaces.
const MODEL = MODEL_CHAIN[0];

/** Status codes where trying the NEXT model in the chain is worth doing.
 *  402 = no credit for THIS (paid) model, 404 = model id retired/unknown,
 *  429 = THIS model's upstream pool is saturated — and, unlike NIM, each
 *  model here can sit behind a different upstream provider, so it is not a
 *  shared budget. 401 is the key itself and is not model-specific. */
function shouldTryNextModel(status: number): boolean {
  return status === 402 || status === 404 || status === 429;
}

// AFFORDABLE-CEILING RETRY (fix 3 in this change's task spec).
//
// PRODUCTION EVIDENCE, 2026-08-31: OpenRouter refused every chain model with
// 402s whose bodies said things like "This request requires more credits, or
// fewer max_tokens. You requested up to 16000 tokens, but can only afford
// 4605." — the account had SOME credit, just not enough to cover the
// requested output ceiling (lib/agent/loop.ts's AGENT_ROUTE_CEILING, 16000).
// Before this fix, a 402 of ANY kind fell straight to shouldTryNextModel(),
// which abandons the model entirely and tries the next one in MODEL_CHAIN —
// so a request that would have fit under a smaller cap on the SAME model
// never got the chance; the whole chain paid another 402 each, one after
// another, for a problem a smaller number would have fixed on the first try.
//
// Parses the affordable number out of the error body defensively: the number
// is not guaranteed to be present (a 402 can mean "zero credit left" with no
// usable ceiling in the message at all) and OpenRouter's wording is not a
// contract this codebase controls — it can change. Returns null on anything
// that doesn't confidently look like "afford <N>", and the caller falls
// through to shouldTryNextModel exactly as it did before this function
// existed (the additive guarantee every other lib/ai/deadline.ts-adjacent
// helper in this codebase follows).
export function parseAffordableTokens(detail: string | undefined): number | null {
  if (!detail) return null;
  const m = detail.match(/afford\s+([\d,]+)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Hard timeout on this tier so a stalled OpenRouter call aborts and the
// caller gets a fast, honest failure instead of a request that hangs until
// the platform kills it. Override with OPENROUTER_TIMEOUT_MS.
const TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 30_000;

export function openrouterConfigured(): boolean {
  return KEY.length > 0;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Try each model in the chain until one answers, or the failure is one that a
 *  different model cannot fix. Logs every skipped model so a rate-limited or
 *  retired id shows up in /logs as a warning instead of silently degrading
 *  the last tier. */
async function complete(messages: OpenAIMessage[], temperature: number, maxTokens: number, deadlineAt?: number, signal?: AbortSignal): Promise<string> {
  let lastErr: any = null;
  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    // THE fix this file exists for: without this check, each of MODEL_CHAIN's
    // entries gets its own fresh TIMEOUT_MS attempt with no regard for how
    // much of the turn's overall budget already went to the ones before it.
    // Checked before EVERY attempt, including the first, so a deadline that
    // arrives already past never starts a call that cannot finish.
    if (isPastDeadline(deadlineAt)) {
      log.warn('openrouter: turn deadline exceeded, stopping model chain', {
        triedCount: i, remaining: MODEL_CHAIN.length - i,
      });
      throw deadlineExceededError('openrouter', lastErr);
    }
    const model = MODEL_CHAIN[i];
    try {
      return await completeWith(model, messages, temperature, maxTokens, deadlineAt, signal);
    } catch (err: any) {
      lastErr = err;
      // A stop must end the WHOLE chain, never try the next model in it —
      // same rule as the router's own candidate loop, applied here because
      // this chain is itself a private retry loop the router never sees
      // into. `err.status` is unset on StoppedError, so shouldTryNextModel
      // below already returns false for it and this throws immediately —
      // this check only makes that intent explicit rather than incidental.
      if (err instanceof StoppedError) throw err;
      const status = Number(err?.status) || 0;
      // See parseAffordableTokens' header comment. Retry the SAME model once
      // with the smaller cap OpenRouter itself named, before falling through
      // shouldTryNextModel's "abandon this model" path — a 402 that names an
      // affordable ceiling is not "this model can't answer", it's "this
      // request asked for more output than the account can pay for".
      if (status === 402) {
        const affordable = parseAffordableTokens(err?.detail);
        if (affordable != null && affordable < maxTokens) {
          log.warn('openrouter: 402 named an affordable ceiling, retrying same model with a smaller cap', {
            model, requestedMaxTokens: maxTokens, affordable,
          });
          try {
            return await completeWith(model, messages, temperature, affordable, deadlineAt, signal);
          } catch (err2: any) {
            lastErr = err2;
            const status2 = Number(err2?.status) || 0;
            if (!shouldTryNextModel(status2) || i === MODEL_CHAIN.length - 1) throw err2;
            log.warn('openrouter: model unavailable, falling back', {
              model, status: status2, next: MODEL_CHAIN[i + 1], detail: String(err2?.detail || '').slice(0, 200),
            });
            continue;
          }
        }
      }
      if (!shouldTryNextModel(status) || i === MODEL_CHAIN.length - 1) throw err;
      log.warn('openrouter: model unavailable, falling back', {
        model, status, next: MODEL_CHAIN[i + 1], detail: String(err?.detail || '').slice(0, 200),
      });
    }
  }
  throw lastErr;
}

/**
 * One attempt, with the prompt-cache marker applied when this model accepts
 * one and the operator has turned markers on — and a SINGLE retry without it
 * if the failure implicates the field.
 *
 * The retry is the whole safety story: the marker is an optimisation, and an
 * optimisation is never allowed to fail a turn that would otherwise have
 * worked. `messages` (unmarked) is kept intact precisely so there is a clean
 * body to resend. See lib/ai/prompt-cache-markers.ts for what is marked,
 * which providers accept markers at all, and why the flag defaults off.
 */
async function completeWith(MODEL: string, messages: OpenAIMessage[], temperature: number, maxTokens: number, deadlineAt?: number, signal?: AbortSignal): Promise<string> {
  const marked = cacheMarkersEnabled() && supportsCacheMarkers(MODEL) ? markSystemPrefix(messages) : null;
  if (!marked) return completeOnce(MODEL, messages, temperature, maxTokens, deadlineAt, signal);
  try {
    return await completeOnce(MODEL, marked, temperature, maxTokens, deadlineAt, signal);
  } catch (err: any) {
    if (err instanceof StoppedError) throw err; // never retry a stop
    if (!implicatesCacheMarkers(Number(err?.status) || 0, err?.detail)) throw err;
    log.warn('openrouter: request failed in a way that implicates the prompt-cache marker, retrying once without it', {
      model: MODEL, status: Number(err?.status) || 0, detail: String(err?.detail || '').slice(0, 200),
    });
    return completeOnce(MODEL, messages, temperature, maxTokens, deadlineAt, signal);
  }
}

async function completeOnce(MODEL: string, messages: MarkableMessage[], temperature: number, maxTokens: number, deadlineAt?: number, signal?: AbortSignal): Promise<string> {
  const ctrl = new AbortController();
  // min(TIMEOUT_MS, time remaining) — never larger than today's constant,
  // only ever tighter, and unaffected when deadlineAt is undefined.
  const effectiveTimeoutMs = boundedTimeoutMs(TIMEOUT_MS, deadlineAt);
  const timer = setTimeout(() => ctrl.abort(), effectiveTimeoutMs);
  // `signal` is the CALLER's own AbortSignal (an in-flight cooperative stop —
  // see lib/agent/stop-watch.ts), additive alongside the timeout controller
  // above. Omitted, `fetchSignal` is exactly `ctrl.signal` — byte-identical
  // to before `signal` existed.
  const fetchSignal = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        // OpenRouter uses these for its public leaderboard attribution only;
        // harmless to omit but recommended by their docs.
        'HTTP-Referer': 'https://app.leadrail.xyz',
        'X-Title': 'LeadRail',
      },
      body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens }),
      signal: fetchSignal,
    });
  } catch (e: any) {
    // The caller's own signal firing is a stop, not a timeout — see the
    // matching comment in lib/ai/opencode.ts's complete(). Checked first: it
    // can race the internal timer, and a stop must always win that race.
    if (signal?.aborted) throw new StoppedError('OpenRouter call aborted: stop requested');
    const err: any = new Error(
      e?.name === 'AbortError' ? `OpenRouter timed out after ${effectiveTimeoutMs}ms` : `OpenRouter request failed`,
    );
    err.code = 'upstream';
    err.detail = String(e?.message || e).slice(0, 300);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    // Put the MODEL and OpenRouter's own reason in the message, not just the
    // status — the same key can succeed on one model and 429/402 on another.
    const err: any = new Error(`OpenRouter failed (${res.status}) model=${MODEL}${detail ? ` — ${detail}` : ''}`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.status = res.status;   // read by shouldTryNextModel() to decide on fallback
    err.detail = detail;
    if (res.status === 429) err.retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    throw err;
  }
  const json = await res.json();
  reportOpenAIUsage(json);
  reportOpenAITiming(json);
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Streaming twin of `complete()`. Same request shape, same error shapes, same
 *  timeout/AbortController pattern (the timer guards the response HEADERS, as
 *  in `complete()`). An empty stream throws the same `upstream` error shape so
 *  the router can fall through rather than hand back a blank answer. */
async function completeStream(
  messages: OpenAIMessage[],
  temperature: number,
  maxTokens: number,
  onDelta: (chunk: string) => void,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<string> {
  // Same chain as complete(). Safe to fall back here because a 402/404/429
  // arrives on the response STATUS, before any delta has been emitted — so no
  // partial answer has reached the client when we switch models.
  let lastErr: any = null;
  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    // Same deadline check as complete()'s chain loop — see its comment.
    if (isPastDeadline(deadlineAt)) {
      log.warn('openrouter: turn deadline exceeded, stopping model chain (stream)', {
        triedCount: i, remaining: MODEL_CHAIN.length - i,
      });
      throw deadlineExceededError('openrouter', lastErr);
    }
    const model = MODEL_CHAIN[i];
    try {
      return await completeStreamWith(model, messages, temperature, maxTokens, onDelta, deadlineAt, signal);
    } catch (err: any) {
      lastErr = err;
      // See the matching check in complete()'s chain loop: a stop ends the
      // whole chain, it never tries the next model.
      if (err instanceof StoppedError) throw err;
      const status = Number(err?.status) || 0;
      // Same affordable-ceiling retry as complete()'s chain loop — see its
      // comment. A 402 here arrives on the response status before any delta
      // has been emitted (see the comment on this function's caller), so
      // retrying the same model with a smaller cap is exactly as safe as the
      // ordinary model-to-model fallback below.
      if (status === 402) {
        const affordable = parseAffordableTokens(err?.detail);
        if (affordable != null && affordable < maxTokens) {
          log.warn('openrouter: 402 named an affordable ceiling, retrying same model with a smaller cap (stream)', {
            model, requestedMaxTokens: maxTokens, affordable,
          });
          try {
            return await completeStreamWith(model, messages, temperature, affordable, onDelta, deadlineAt, signal);
          } catch (err2: any) {
            lastErr = err2;
            const status2 = Number(err2?.status) || 0;
            if (!shouldTryNextModel(status2) || i === MODEL_CHAIN.length - 1) throw err2;
            log.warn('openrouter: model unavailable (stream), falling back', {
              model, status: status2, next: MODEL_CHAIN[i + 1],
            });
            continue;
          }
        }
      }
      if (!shouldTryNextModel(status) || i === MODEL_CHAIN.length - 1) throw err;
      log.warn('openrouter: model unavailable (stream), falling back', {
        model, status, next: MODEL_CHAIN[i + 1],
      });
    }
  }
  throw lastErr;
}

/** Streaming twin of completeWith's marker handling — same gate, same single
 *  retry without the marker. The two must stay identical: the streaming path
 *  is what real chat turns run, and a safety net applied to only one of them
 *  is not applied.
 *
 *  A retry here cannot double-emit deltas, and that is a property of the
 *  error shapes rather than luck: every failure that can occur AFTER the
 *  first onDelta (an empty stream, a truncated body) is thrown without a
 *  `status`, and implicatesCacheMarkers only says yes to a 4xx or to a
 *  detail that literally names cache_control. A rejected field is answered
 *  by the `!res.ok` branch, which runs before the body is read at all. Any
 *  future error shape added below the stream loop MUST stay status-less, or
 *  it must be excluded here explicitly. */
async function completeStreamWith(
  MODEL: string,
  messages: OpenAIMessage[],
  temperature: number,
  maxTokens: number,
  onDelta: (chunk: string) => void,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<string> {
  const marked = cacheMarkersEnabled() && supportsCacheMarkers(MODEL) ? markSystemPrefix(messages) : null;
  if (!marked) return completeStreamOnce(MODEL, messages, temperature, maxTokens, onDelta, deadlineAt, signal);
  try {
    return await completeStreamOnce(MODEL, marked, temperature, maxTokens, onDelta, deadlineAt, signal);
  } catch (err: any) {
    if (err instanceof StoppedError) throw err; // never retry a stop
    if (!implicatesCacheMarkers(Number(err?.status) || 0, err?.detail)) throw err;
    log.warn('openrouter: stream failed in a way that implicates the prompt-cache marker, retrying once without it', {
      model: MODEL, status: Number(err?.status) || 0, detail: String(err?.detail || '').slice(0, 200),
    });
    return completeStreamOnce(MODEL, messages, temperature, maxTokens, onDelta, deadlineAt, signal);
  }
}

async function completeStreamOnce(
  MODEL: string,
  messages: MarkableMessage[],
  temperature: number,
  maxTokens: number,
  onDelta: (chunk: string) => void,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<string> {
  const ctrl = new AbortController();
  const effectiveTimeoutMs = boundedTimeoutMs(TIMEOUT_MS, deadlineAt);
  const timer = setTimeout(() => ctrl.abort(), effectiveTimeoutMs);
  const fetchSignal = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://app.leadrail.xyz',
        'X-Title': 'LeadRail',
      },
      body: JSON.stringify({
        model: MODEL, messages, temperature, max_tokens: maxTokens, stream: true,
        // See readSseDeltas: without this an OpenAI-dialect stream reports no
        // usage, which is why streamed calls never recorded tokens.
        stream_options: { include_usage: true },
      }),
      signal: fetchSignal,
    });
  } catch (e: any) {
    if (signal?.aborted) throw new StoppedError('OpenRouter call aborted: stop requested');
    const err: any = new Error(
      e?.name === 'AbortError' ? `OpenRouter timed out after ${effectiveTimeoutMs}ms` : `OpenRouter request failed`,
    );
    err.code = 'upstream';
    err.detail = String(e?.message || e).slice(0, 300);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`OpenRouter failed (${res.status}) model=${MODEL}${detail ? ` — ${detail}` : ''}`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.status = res.status;   // read by shouldTryNextModel() to decide on fallback
    err.detail = detail;
    if (res.status === 429) err.retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    throw err;
  }
  if (!res.body) {
    const err: any = new Error('OpenRouter returned no response stream');
    err.code = 'upstream';
    throw err;
  }

  let text = '';
  try {
    await readSseDeltas(res.body, (evt) => {
      const chunk = evt?.choices?.[0]?.delta?.content;
      if (typeof chunk === 'string' && chunk) {
        text += chunk;
        onDelta(chunk);
      }
    });
  } catch (e: any) {
    // Same stop-vs-timeout distinction as the initial fetch, applied where
    // an abort mid-body-read actually surfaces. Unreachable when `signal` is
    // undefined/never aborted, so behaviour without it is unchanged.
    if (signal?.aborted) throw new StoppedError('OpenRouter stream aborted: stop requested');
    throw e;
  }

  const out = text.trim();
  if (!out) {
    const err: any = new Error('OpenRouter returned an empty stream');
    err.code = 'upstream';
    throw err;
  }
  return out;
}

/** Streaming twin of `openrouterChat`. Forwards each token delta to `onDelta`
 *  and resolves with the COMPLETE text. */
export async function openrouterStreamChat(
  opts: {
    system?: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    temperature?: number;
    maxOutputTokens?: number;
    /** Absolute epoch-ms deadline for the whole turn this call belongs to.
     *  Optional/additive — omitted, behaviour is unchanged. See lib/ai/deadline.ts. */
    deadlineAt?: number;
    /** External abort, e.g. an in-flight cooperative stop (lib/agent/
     *  stop-watch.ts). Optional/additive — omitted, behaviour is unchanged. */
    signal?: AbortSignal;
  },
  onDelta: (chunk: string) => void,
): Promise<string> {
  const messages: OpenAIMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) {
    if (m.content?.trim()) messages.push({ role: m.role, content: m.content });
  }
  return completeStream(messages, opts.temperature ?? 0.6, opts.maxOutputTokens ?? DEFAULT_MAX_OUT, onDelta, opts.deadlineAt, opts.signal);
}

/** Generate text. Returns the model's plain-text completion. */
export async function openrouterText(opts: {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Absolute epoch-ms deadline for the whole turn this call belongs to.
   *  Optional/additive — omitted, behaviour is unchanged. See lib/ai/deadline.ts. */
  deadlineAt?: number;
  /** External abort, e.g. an in-flight cooperative stop (lib/agent/
   *  stop-watch.ts). Optional/additive — omitted, behaviour is unchanged. */
  signal?: AbortSignal;
}): Promise<string> {
  const messages: OpenAIMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });
  return complete(messages, opts.temperature ?? 0.7, opts.maxOutputTokens ?? DEFAULT_MAX_OUT, opts.deadlineAt, opts.signal);
}

/** Multi-turn chat completion. Passes the whole conversation through. */
export async function openrouterChat(opts: {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Absolute epoch-ms deadline for the whole turn this call belongs to.
   *  Optional/additive — omitted, behaviour is unchanged. See lib/ai/deadline.ts. */
  deadlineAt?: number;
  /** External abort, e.g. an in-flight cooperative stop (lib/agent/
   *  stop-watch.ts). Optional/additive — omitted, behaviour is unchanged. */
  signal?: AbortSignal;
}): Promise<string> {
  const messages: OpenAIMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) {
    if (m.content?.trim()) messages.push({ role: m.role, content: m.content });
  }
  return complete(messages, opts.temperature ?? 0.6, opts.maxOutputTokens ?? DEFAULT_MAX_OUT, opts.deadlineAt, opts.signal);
}

// ---------------------------------------------------------------------------
// Image generation — fallback tier for ./image-router, not the router ladder.
// ---------------------------------------------------------------------------

// OpenRouter serves a handful of image-output chat models: request them with
// `modalities: ["image", "text"]` and the image comes back as a data URL on
// `message.images`, not as a normal chat completion. Verified live
// (2026-08-19): google/gemini-2.5-flash-image returned a real image at
// ~$0.00003/output-token — cheap, not free, so this is a paid fallback tier
// (same trade-off as deepseek-v4-flash in the text chain).
const IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image';
const IMAGE_TIMEOUT_MS = Number(process.env.OPENROUTER_IMAGE_TIMEOUT_MS) || 40_000;

export interface OpenRouterImage { mimeType: string; base64: string }

/** Generate a static image via an OpenRouter image-output chat model. */
export async function openrouterGenerateImage(opts: { prompt: string }): Promise<OpenRouterImage> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://app.leadrail.xyz',
        'X-Title': 'LeadRail',
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        messages: [{ role: 'user', content: opts.prompt }],
        modalities: ['image', 'text'],
      }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    const err: any = new Error(e?.name === 'AbortError' ? `OpenRouter image timed out after ${IMAGE_TIMEOUT_MS}ms` : 'OpenRouter image request failed');
    err.code = 'upstream';
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`OpenRouter image failed (${res.status}) model=${IMAGE_MODEL}${detail ? ` — ${detail}` : ''}`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  // OpenRouter returns images as data URLs: message.images[0].image_url.url
  const dataUrl = json?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    const err: any = new Error('OpenRouter returned no image');
    err.code = 'upstream';
    throw err;
  }
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    const err: any = new Error('OpenRouter image data URL was malformed');
    err.code = 'upstream';
    throw err;
  }
  return { mimeType: match[1], base64: match[2] };
}

/** Call ONE specific model directly, bypassing the chain (see probeNimModel). */
export async function probeOpenrouterModel(model: string): Promise<string> {
  return completeWith(model, [{ role: 'user', content: 'Reply with one word: ok' }], 0, 16);
}

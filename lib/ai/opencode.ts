// OpenCode Go client — text + multi-turn chat via DeepSeek V4 Pro.
// OpenAI-compatible Chat Completions endpoint. Draws on the OpenCode Go
// subscription (not Zen pay-per-use credits). Admin/account-scoped generation
// only; a route handler invokes it on explicit request. Image generation stays
// on Gemini (see ./gemini) — OpenCode returns text, not image bytes.

// Default output budget when a caller does not specify one.
//
// This used to be a per-file literal (2048 here, 900 in huggingface.ts), which
// silently capped long-form work: a strategy or an editorial review would stop
// mid-sentence and read as a model failure rather than a budget we chose.
//
// The registry path has a proper per-model resolver (resolveMaxOutputTokens,
// migration 038) that asks the selected model for its real ceiling — but
// ai_providers is empty, so that path never runs and these literals ARE the hard
// limit today. Set high enough to mean "as much as the model will give", and
// override with AI_MAX_OUTPUT_TOKENS.
import { reportOpenAIUsage, reportUsage, reportProviderNotReported, reportOpenAITiming, reportTimingNotReported, reportProviderTiming } from './usage';
import { parseRetryAfterMs } from './health';
import { boundedTimeoutMs, deadlineExceededError, isPastDeadline } from './deadline';
import { StoppedError } from './abort';

const DEFAULT_MAX_OUT = Number(process.env.AI_MAX_OUTPUT_TOKENS) || 16000;

const KEY =
  process.env.OPENCODE_API_KEY ||
  process.env.OpenCode_Api_Key ||
  process.env.OPENCODE_GO_API_KEY ||
  '';
// Base + model are env-overridable so the model can be swapped without a code
// change. Defaults track the OpenCode Go DeepSeek V4 Pro endpoint.
const BASE = (process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/go/v1').replace(/\/$/, '');
const TEXT_MODEL = process.env.OPENCODE_MODEL || 'deepseek-v4-pro';
const RELIABLE_FALLBACK = 'deepseek-v4-pro';

// Hard timeout so a stalled OpenCode call aborts and the router fails over to
// NIM instead of blocking the whole request. Without this a hung upstream hangs
// unbounded (the Aug-1 outreach 502s were a stalled tier that never aborted).
// Override with OPENCODE_TIMEOUT_MS.
const TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS) || 35_000;

export function opencodeConfigured(): boolean {
  return KEY.length > 0;
}

function requireKey() {
  if (!KEY) {
    const err: any = new Error('OpenCode is not connected');
    err.code = 'not_configured';
    throw err;
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function complete(messages: OpenAIMessage[], temperature: number, maxTokens: number, model?: string, deadlineAt?: number, signal?: AbortSignal): Promise<string> {
  requireKey();
  // Checked before starting the fetch, not just used to shrink the abort
  // timer below — a deadline already past means this attempt cannot finish,
  // so it must not be started.
  if (isPastDeadline(deadlineAt)) throw deadlineExceededError('opencode');
  const useModel = model || TEXT_MODEL;
  const body: Record<string, any> = {
    model: useModel,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  // DeepSeek V4 is a reasoning model: with thinking ON it burns the entire
  // max_tokens budget on hidden reasoning_content and returns empty content.
  // Disable thinking so the budget goes to the actual answer. The param is
  // DeepSeek-specific, so only send it for DeepSeek models — a GLM/Kimi/etc.
  // override won't get an unknown field.
  if (/deepseek/i.test(useModel)) body.thinking = { type: 'disabled' };

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
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: fetchSignal,
    });
  } catch (e: any) {
    // The caller's own signal firing is a stop, not a timeout — a distinct
    // error the router's candidate loop must never treat as an ordinary
    // provider failure eligible for fallback. Checked first: it can race the
    // internal timer, and a stop must always win that race.
    if (signal?.aborted) throw new StoppedError('OpenCode call aborted: stop requested');
    const err: any = new Error(
      e?.name === 'AbortError' ? `OpenCode timed out after ${effectiveTimeoutMs}ms` : `OpenCode request failed`,
    );
    err.code = 'upstream';
    err.detail = String(e?.message || e).slice(0, 300);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`OpenCode failed (${res.status})`);
    // 401/403 from OpenCode covers both bad key and CreditsError (billing).
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.status = res.status;
    err.detail = detail;
    if (res.status === 429) err.retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    throw err;
  }
  const json = await res.json();
  reportOpenAIUsage(json);
  reportOpenAITiming(json);
  // DeepSeek returns the answer in message.content; reasoning_content is separate
  // scratch and is deliberately ignored.
  const content = json?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';

  // Self-heal: some Go models (kimi/qwen/glm/...) reason uncontrollably on this
  // endpoint and return EMPTY content. If that happens on a non-DeepSeek model,
  // retry once on the reliable DeepSeek backbone (thinking disabled) so a caller
  // never receives a blank. DeepSeek emptiness is a real failure — don't loop.
  // Guarded by the same deadline check as the top of this function: this
  // retry is itself a second attempt with its own fresh timeout, exactly the
  // shape of unbounded-sum bug this file's callers exist to prevent — skip it
  // once the deadline has passed rather than starting a call that cannot
  // finish, and return the (empty) text as-is.
  if (!text && !/deepseek/i.test(useModel) && !isPastDeadline(deadlineAt)) {
    return complete(messages, temperature, maxTokens, RELIABLE_FALLBACK, deadlineAt, signal);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Streaming (Packet 8.1c) — pure addition. `complete()` above is untouched.
// ---------------------------------------------------------------------------

/**
 * Shared SSE line reader for OpenAI-compatible `stream: true` responses.
 * Parses `data: ` lines, ignores `[DONE]` and non-data lines, and handles
 * frames split across network chunk boundaries.
 *
 * It lives in this module rather than in router.ts because opencode.ts is a
 * dependency-free leaf that BOTH router.ts and providers.ts already import;
 * hosting it in router.ts would make providers.ts import router.ts, which
 * router.ts already imports (a circular import).
 */
export async function readSseDeltas(
  body: ReadableStream<Uint8Array>,
  onEvent: (payload: any) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  // TOKEN ACCOUNTING FOR STREAMED RESPONSES.
  //
  // Every streaming tier in this codebase funnels through this function —
  // opencode, nim, openrouter, huggingface, and both branches of the
  // registry path in providers.ts. That made it the one place where usage
  // could be captured without six copies drifting apart, which is the same
  // reasoning that put reportOpenAIUsage in one place for the non-streaming
  // half (see lib/ai/usage.ts).
  //
  // It was worth fixing here because the numbers were essentially never
  // recorded: of 364 ai_usage rows, exactly ONE carried tokens. Every client
  // called reportOpenAIUsage from its non-streaming complete() only, and the
  // agent — the thing that makes almost all the calls — streams.
  //
  // Accumulated across frames rather than read from one, because the two
  // dialects deliver it differently: an OpenAI-compatible gateway sends a
  // single final chunk carrying the whole block (and only when the request
  // asked, via stream_options.include_usage), while Anthropic splits it —
  // input_tokens on `message_start`, output_tokens on `message_delta`.
  // Reporting each frame as it arrived would let the second erase the first,
  // since reportUsage is last-writer-wins by design.
  //
  // Reported ONCE, after the stream ends, so the accumulation cannot leak
  // across a fallback to another model: a stream that has emitted frames is
  // never retried (status-code failures arrive before the first delta).
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  // Same field names as reportOpenAITiming — see lib/ai/usage.ts. Neither
  // provider sends these on a stream frame today (measured 2026-08-29), but
  // checked per-frame anyway alongside noteUsage so a future addition needs
  // no change here.
  let timingMs: number | null = null;
  const noteUsage = (evt: any) => {
    const u = evt?.usage ?? evt?.message?.usage;
    if (!u) return;
    const i = u.prompt_tokens ?? u.input_tokens;
    const o = u.completion_tokens ?? u.output_tokens;
    if (typeof i === 'number' && Number.isFinite(i)) tokensIn = i;
    if (typeof o === 'number' && Number.isFinite(o)) tokensOut = o;
    const t = u.generation_time ?? u.latency;
    if (typeof t === 'number' && Number.isFinite(t)) timingMs = t;
  };

  const handleLine = (raw: string) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let evt: any;
    try { evt = JSON.parse(payload); } catch { return; /* skip a malformed frame */ }
    // Usage is noted even if the consumer throws on this frame — the numbers
    // describe the call that was already made either way.
    noteUsage(evt);
    onEvent(evt);
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  }
  if (buf) handleLine(buf);
  // NULL, not 0, when the tier reported nothing — "does not tell us" and "used
  // no tokens" are different facts (see lib/ai/usage.ts). The stream ran to
  // completion either way, so a frameless outcome is provider_not_reported —
  // we read every frame there was — not not_attempted, which would say this
  // code never looked.
  if (tokensIn != null || tokensOut != null) reportUsage({ tokensIn, tokensOut });
  else reportProviderNotReported();
  if (timingMs != null) reportProviderTiming(timingMs);
  else reportTimingNotReported();
}

/** Streaming twin of `complete()`. Same request shape, same error shapes, same
 *  timeout/AbortController pattern (the timer guards the response HEADERS, as
 *  in `complete()`; the body is then read to completion).
 *
 *  Deliberately does NOT reproduce `complete()`'s empty-content self-heal
 *  retry: re-running a call that has already emitted deltas would duplicate
 *  visible output. An empty stream throws the same `upstream` error shape so
 *  the router simply falls through to the next tier. */
async function completeStream(
  messages: OpenAIMessage[],
  temperature: number,
  maxTokens: number,
  model: string | undefined,
  onDelta: (chunk: string) => void,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<string> {
  requireKey();
  if (isPastDeadline(deadlineAt)) throw deadlineExceededError('opencode');
  const useModel = model || TEXT_MODEL;
  const body: Record<string, any> = {
    model: useModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
    // Ask the gateway to append a final chunk carrying the token counts.
    // Without it an OpenAI-dialect stream reports no usage at all, which is
    // why 363 of 364 ai_usage rows had NULL tokens. OpenAI-compatible only —
    // deliberately NOT sent on the Anthropic branch, where it is not a valid
    // parameter and usage arrives unprompted on message_start/message_delta.
    stream_options: { include_usage: true },
  };
  // Same DeepSeek rule as complete(): thinking ON burns the whole budget on
  // hidden reasoning_content and returns nothing usable.
  if (/deepseek/i.test(useModel)) body.thinking = { type: 'disabled' };

  const ctrl = new AbortController();
  const effectiveTimeoutMs = boundedTimeoutMs(TIMEOUT_MS, deadlineAt);
  const timer = setTimeout(() => ctrl.abort(), effectiveTimeoutMs);
  const fetchSignal = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: fetchSignal,
    });
  } catch (e: any) {
    if (signal?.aborted) throw new StoppedError('OpenCode call aborted: stop requested');
    const err: any = new Error(
      e?.name === 'AbortError' ? `OpenCode timed out after ${effectiveTimeoutMs}ms` : `OpenCode request failed`,
    );
    err.code = 'upstream';
    err.detail = String(e?.message || e).slice(0, 300);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`OpenCode failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.status = res.status;
    err.detail = detail;
    if (res.status === 429) err.retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    throw err;
  }
  if (!res.body) {
    const err: any = new Error('OpenCode returned no response stream');
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
    // The abort can land mid-body-read (after headers, before the stream
    // finishes) rather than on the initial fetch — same stop-vs-timeout
    // distinction as above, applied where the abort actually surfaces.
    // `signal` undefined/never-aborted leaves this branch unreachable, so a
    // caller with no external signal sees the original error, unchanged.
    if (signal?.aborted) throw new StoppedError('OpenCode stream aborted: stop requested');
    throw e;
  }

  const out = text.trim();
  if (!out) {
    const err: any = new Error('OpenCode returned an empty stream');
    err.code = 'upstream';
    throw err;
  }
  return out;
}

/** Streaming twin of `generateChat`. Forwards each token delta to `onDelta`
 *  and resolves with the COMPLETE text. */
export async function streamChat(
  opts: {
    system?: string;
    messages: ChatMessage[];
    temperature?: number;
    maxOutputTokens?: number;
    model?: string;
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
  return completeStream(messages, opts.temperature ?? 0.6, opts.maxOutputTokens ?? DEFAULT_MAX_OUT, opts.model, onDelta, opts.deadlineAt, opts.signal);
}

/** Generate text. Returns the model's plain-text completion. Pass `model` to
 * override the default (Hermes routes different tasks to different Go models). */
export async function generateText(opts: {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
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
  return complete(messages, opts.temperature ?? 0.7, opts.maxOutputTokens ?? DEFAULT_MAX_OUT, opts.model, opts.deadlineAt, opts.signal);
}

/**
 * Multi-turn chat completion. Passes the whole conversation so the model can
 * ask clarifying questions and refine across turns.
 */
export async function generateChat(opts: {
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
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
  return complete(messages, opts.temperature ?? 0.6, opts.maxOutputTokens ?? DEFAULT_MAX_OUT, opts.model, opts.deadlineAt, opts.signal);
}

export const opencodeModel = TEXT_MODEL;

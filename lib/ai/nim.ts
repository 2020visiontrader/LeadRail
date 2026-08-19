// NVIDIA NIM client — OpenAI-compatible Chat Completions. Last-resort tier of
// the AI routing ladder (see ./router): reached only when Ask Zo and OpenCode
// Go both fail or are unconfigured. Also exposes a single image-generation
// model (see nimGenerateImage below) used as a fallback tier by
// ./image-router when Gemini is down or unconfigured.

// readSseDeltas is shared from opencode.ts, a dependency-free leaf module —
// both are OpenAI-compatible Chat Completions transports. Importing it from
// router.ts instead would create a circular import (router.ts imports this file).
import { readSseDeltas } from './opencode';

const KEY = process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY || '';
import { log } from '@/lib/logger';

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

const BASE = 'https://integrate.api.nvidia.com/v1';
// Ordered fallback chain, not a single pinned model. NIM_MODEL still wins when
// set, so the operator keeps full control.
//
// WHY A CHAIN: build.nvidia.com rotates its free tier. A model that was free
// last quarter can lose entitlement, and the request then fails 403 — which
// reads exactly like a bad API key. That is precisely how this broke: NIM is the
// LAST tier in the router ladder, so when it 403s the assistant has nothing left
// and returns "temporarily unavailable" with no clue that a single retired model
// id was the cause.
//
// Order is deliberate: a current long-context agentic model first, then two
// widely-available fallbacks that have outlived several catalog rotations. The
// chain only advances on a 403/404 (entitlement or model-not-found) — never on a
// 401 (key is genuinely bad, trying another model cannot help) and never on 429
// or 5xx (transient; retrying a different model just burns the rate limit).
//
// Verified live against NVIDIA's current catalog (2026-08-19): pulled GET
// /v1/models, then smoke-tested every candidate with a real chat completion.
// Additive only — every model that was already in this chain stays in it,
// new verified ones are added ahead of the two that were timing out (>25s)
// under load just now, so a working fast model gets tried first and the
// slow ones are still here as extra depth rather than removed:
//   nvidia/nemotron-3.5-lightning   -> catalog id is actually
//                                      nvidia/nemotron-3.5-lightning-30b-a3b
//                                      (kept both: the corrected id up front,
//                                      the original id NIM_MODEL can still
//                                      target directly stays reachable below)
//   z-ai/glm-5.2                    -> not in NVIDIA's catalog at all (it's an
//                                      OpenRouter-only id) — always 404s, but
//                                      the chain already treats 404 as
//                                      try-next, so it's a harmless fast
//                                      no-op rather than something worth
//                                      deleting
// Spans NVIDIA's own Nemotron family (least likely to lose free-tier
// entitlement on their own catalog) plus Mistral, DeepSeek, OpenAI OSS, and
// Meta for provider diversity, so one vendor's rotation can't take the whole
// tier down.
export const MODEL_CHAIN = (process.env.NIM_MODEL
  ? [process.env.NIM_MODEL]
  : [
      // ── ORDERED BY MEASURED LATENCY (probe 2026-08-19, /api/admin/model-probe).
      // This chain used to lead with nvidia/nemotron-nano-12b-v2-vl, which
      // answers in 10.8s — and had been 500ing and timing out all evening. Every
      // NIM call walked past it first. mistral-nemotron answers the same prompt
      // in 252ms, a 43x difference that was invisible until each model was timed
      // individually.
      //
      // VERIFIED-DEAD entries are kept but demoted to the END rather than
      // deleted: an id can come back, the probe is the thing that decides, and a
      // dead tail costs nothing now that nothing reaches it. Their failure is
      // recorded here so nobody re-promotes them on a hunch.
      'mistralai/mistral-nemotron',
      'openai/gpt-oss-20b',
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'nvidia/nemotron-3-super-120b-a12b',
      'nvidia/nvidia-nemotron-nano-9b-v2',
      'deepseek-ai/deepseek-v4-flash-0731',
      'nvidia/nemotron-nano-12b-v2-vl',
      // ── Verified present in the provider catalog, not yet latency-tested.
      'openai/gpt-oss-120b',
      'google/gemma-4-31b-it',
      'nvidia/llama-3.1-nemotron-ultra-253b-v1',
      'nvidia/nemotron-nano-3-30b-a3b',
      'nvidia/llama-3.3-nemotron-super-49b-v1',
      'mistralai/mistral-large-2-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'google/gemma-3-12b-it',
      'nv-mistralai/mistral-nemo-12b-instruct',
      // ── VERIFIED DEAD 2026-08-19 (all four timed out at 12s). Demoted, not
      // deleted — see note above.
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
      'meta/llama-3.3-70b-instruct',
      'z-ai/glm-5.2',
      'meta/llama-3.1-8b-instruct',
    ]);
const MODEL = MODEL_CHAIN[0];

/** Status codes where trying the NEXT model in the chain is worth doing.
 *  403 = no entitlement for THIS model, 404 = model id retired. Both are
 *  per-model and survivable. 401 is the key itself and is not. */
function shouldTryNextModel(status: number): boolean {
  return status === 403 || status === 404;
}

// Hard timeout on the last-resort tier so a stalled NIM call aborts and the
// caller gets a fast, honest failure instead of a request that hangs until the
// platform kills it. Override with NIM_TIMEOUT_MS.
// 12s, not 30s. A timeout is paid IN FULL on every call before the ladder moves
// on, so a long one on a dead tier is the most expensive failure mode there is —
// observed live at 30s per call while NIM was down upstream. The circuit breaker
// now caps how often that happens, but the first failure still costs this, so it
// should be short enough to absorb. Override with NIM_TIMEOUT_MS.
const TIMEOUT_MS = Number(process.env.NIM_TIMEOUT_MS) || 12_000;

export function nimConfigured(): boolean {
  return KEY.length > 0;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Try each model in the chain until one answers, or the failure is one that a
 *  different model cannot fix. Logs every skipped model so a retired id shows up
 *  in /logs as a warning instead of silently degrading the last tier. */
async function complete(messages: OpenAIMessage[], temperature: number, maxTokens: number): Promise<string> {
  let lastErr: any = null;
  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    try {
      return await completeWith(model, messages, temperature, maxTokens);
    } catch (err: any) {
      lastErr = err;
      const status = Number(err?.status) || 0;
      if (!shouldTryNextModel(status) || i === MODEL_CHAIN.length - 1) throw err;
      log.warn('nim: model unavailable, falling back', {
        model, status, next: MODEL_CHAIN[i + 1], detail: String(err?.detail || '').slice(0, 200),
      });
    }
  }
  throw lastErr;
}

async function completeWith(MODEL: string, messages: OpenAIMessage[], temperature: number, maxTokens: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    const err: any = new Error(
      e?.name === 'AbortError' ? `NIM timed out after ${TIMEOUT_MS}ms` : `NIM request failed`,
    );
    err.code = 'upstream';
    err.detail = String(e?.message || e).slice(0, 300);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    // Put the MODEL and NVIDIA's own reason in the message, not just the status.
    // `err.detail` carried the reason already, but the error serializer keeps
    // only name/message/stack — so a production 403 logged as a bare
    // "NIM failed (403)" with the actual cause discarded. A 403 here is usually
    // per-model entitlement rather than a bad key, so the model id is the single
    // most useful thing to know: the same key can succeed on one model and 403
    // on another that has left the free tier.
    const err: any = new Error(`NIM failed (${res.status}) model=${MODEL}${detail ? ` — ${detail}` : ''}`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.status = res.status;   // read by shouldTryNextModel() to decide on fallback
    err.detail = detail;
    throw err;
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

// ---------------------------------------------------------------------------
// Streaming (Packet 8.1c) — pure addition. `complete()` above is untouched.
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
): Promise<string> {
  // Same chain as complete(). Safe to fall back here because a 403/404 arrives
  // on the response STATUS, before any delta has been emitted — so no partial
  // answer has reached the client when we switch models.
  let lastErr: any = null;
  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    try {
      return await completeStreamWith(model, messages, temperature, maxTokens, onDelta);
    } catch (err: any) {
      lastErr = err;
      const status = Number(err?.status) || 0;
      if (!shouldTryNextModel(status) || i === MODEL_CHAIN.length - 1) throw err;
      log.warn('nim: model unavailable (stream), falling back', {
        model, status, next: MODEL_CHAIN[i + 1],
      });
    }
  }
  throw lastErr;
}

async function completeStreamWith(
  MODEL: string,
  messages: OpenAIMessage[],
  temperature: number,
  maxTokens: number,
  onDelta: (chunk: string) => void,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens, stream: true }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    const err: any = new Error(
      e?.name === 'AbortError' ? `NIM timed out after ${TIMEOUT_MS}ms` : `NIM request failed`,
    );
    err.code = 'upstream';
    err.detail = String(e?.message || e).slice(0, 300);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    // Put the MODEL and NVIDIA's own reason in the message, not just the status.
    // `err.detail` carried the reason already, but the error serializer keeps
    // only name/message/stack — so a production 403 logged as a bare
    // "NIM failed (403)" with the actual cause discarded. A 403 here is usually
    // per-model entitlement rather than a bad key, so the model id is the single
    // most useful thing to know: the same key can succeed on one model and 403
    // on another that has left the free tier.
    const err: any = new Error(`NIM failed (${res.status}) model=${MODEL}${detail ? ` — ${detail}` : ''}`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.status = res.status;   // read by shouldTryNextModel() to decide on fallback
    err.detail = detail;
    throw err;
  }
  if (!res.body) {
    const err: any = new Error('NIM returned no response stream');
    err.code = 'upstream';
    throw err;
  }

  let text = '';
  await readSseDeltas(res.body, (evt) => {
    const chunk = evt?.choices?.[0]?.delta?.content;
    if (typeof chunk === 'string' && chunk) {
      text += chunk;
      onDelta(chunk);
    }
  });

  const out = text.trim();
  if (!out) {
    const err: any = new Error('NIM returned an empty stream');
    err.code = 'upstream';
    throw err;
  }
  return out;
}

/** Streaming twin of `nimChat`. Forwards each token delta to `onDelta` and
 *  resolves with the COMPLETE text. */
export async function nimStreamChat(
  opts: {
    system?: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    temperature?: number;
    maxOutputTokens?: number;
  },
  onDelta: (chunk: string) => void,
): Promise<string> {
  const messages: OpenAIMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) {
    if (m.content?.trim()) messages.push({ role: m.role, content: m.content });
  }
  return completeStream(messages, opts.temperature ?? 0.6, opts.maxOutputTokens ?? DEFAULT_MAX_OUT, onDelta);
}

/** Generate text. Returns the model's plain-text completion. */
export async function nimText(opts: {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<string> {
  const messages: OpenAIMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });
  return complete(messages, opts.temperature ?? 0.7, opts.maxOutputTokens ?? DEFAULT_MAX_OUT);
}

/** Multi-turn chat completion. Passes the whole conversation through. */
export async function nimChat(opts: {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<string> {
  const messages: OpenAIMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) {
    if (m.content?.trim()) messages.push({ role: m.role, content: m.content });
  }
  return complete(messages, opts.temperature ?? 0.6, opts.maxOutputTokens ?? DEFAULT_MAX_OUT);
}

// ---------------------------------------------------------------------------
// Image generation — fallback tier for ./image-router, not the router ladder.
// ---------------------------------------------------------------------------

// NVIDIA's image models live on a separate host (ai.api.nvidia.com, not
// integrate.api.nvidia.com) under the "genai" path, with a Stability-style
// request/response shape rather than OpenAI's chat completions. Verified live
// (2026-08-19): stabilityai/stable-diffusion-3-medium and stabilityai/sdxl-turbo
// both 404 on this account's entitlement; black-forest-labs/flux.1-dev
// returned a real image. Single model, not a chain — this whole tier is
// already a fallback, so there is no third option to fall back to.
const IMAGE_BASE = 'https://ai.api.nvidia.com/v1/genai';
const IMAGE_MODEL = process.env.NIM_IMAGE_MODEL || 'black-forest-labs/flux.1-dev';
const IMAGE_TIMEOUT_MS = Number(process.env.NIM_IMAGE_TIMEOUT_MS) || 30_000;

export interface NimImage { mimeType: string; base64: string }

/** Generate a static image via NIM's Stability-style genai endpoint. */
export async function nimGenerateImage(opts: { prompt: string }): Promise<NimImage> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${IMAGE_BASE}/${IMAGE_MODEL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ text_prompts: [{ text: opts.prompt, weight: 1 }], cfg_scale: 5, steps: 20 }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    const err: any = new Error(e?.name === 'AbortError' ? `NIM image timed out after ${IMAGE_TIMEOUT_MS}ms` : 'NIM image request failed');
    err.code = 'upstream';
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`NIM image failed (${res.status}) model=${IMAGE_MODEL}${detail ? ` — ${detail}` : ''}`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const b64 = json?.artifacts?.[0]?.base64;
  if (typeof b64 !== 'string' || !b64) {
    const err: any = new Error('NIM image returned no artifact');
    err.code = 'upstream';
    throw err;
  }
  return { mimeType: 'image/png', base64: b64 };
}
/** Call ONE specific model directly, bypassing the chain. Used by
 *  /api/admin/ai-probe to test every entry rather than only whichever the chain
 *  happens to land on — a tier reporting "ok" tells you nothing about the ten
 *  models behind the one that answered. */
export async function probeNimModel(model: string): Promise<string> {
  return completeWith(model, [{ role: 'user', content: 'Reply with one word: ok' }], 0, 16);
}

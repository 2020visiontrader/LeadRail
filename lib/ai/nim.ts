// NVIDIA NIM client — OpenAI-compatible Chat Completions. Last-resort tier of
// the AI routing ladder (see ./router): reached only when Ask Zo and OpenCode
// Go both fail or are unconfigured. Text/chat only; images stay on Gemini.

// readSseDeltas is shared from opencode.ts, a dependency-free leaf module —
// both are OpenAI-compatible Chat Completions transports. Importing it from
// router.ts instead would create a circular import (router.ts imports this file).
import { readSseDeltas } from './opencode';

const KEY = process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY || '';
import { log } from '@/lib/logger';

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
const MODEL_CHAIN = (process.env.NIM_MODEL
  ? [process.env.NIM_MODEL]
  : ['z-ai/glm-5.2', 'meta/llama-3.3-70b-instruct', 'meta/llama-3.1-8b-instruct']);
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
const TIMEOUT_MS = Number(process.env.NIM_TIMEOUT_MS) || 30_000;

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
  return completeStream(messages, opts.temperature ?? 0.6, opts.maxOutputTokens ?? 2048, onDelta);
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
  return complete(messages, opts.temperature ?? 0.7, opts.maxOutputTokens ?? 2048);
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
  return complete(messages, opts.temperature ?? 0.6, opts.maxOutputTokens ?? 2048);
}
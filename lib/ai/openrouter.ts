// OpenRouter client — OpenAI-compatible Chat Completions. Fourth tier of the
// AI routing ladder (see ./router): reached only when Ask Zo, OpenCode Go, and
// NVIDIA NIM all fail or are unconfigured. Also exposes a single image-output
// model (see openrouterGenerateImage below) used as a fallback tier by
// ./image-router when Gemini and NIM are both down or unconfigured.

// readSseDeltas is shared from opencode.ts, a dependency-free leaf module —
// both are OpenAI-compatible Chat Completions transports.
import { readSseDeltas } from './opencode';
import { log } from '@/lib/logger';

const KEY = process.env.OPENROUTER_API_KEY || '';

const BASE = 'https://openrouter.ai/api/v1';
// Ordered fallback chain, not a single pinned model. OPENROUTER_MODEL still
// wins when set, so the operator keeps full control.
//
// WHY A CHAIN: OpenRouter's free-tier models (":free" suffix) sit behind a
// shared public pool per upstream provider, and that pool can be
// rate-limited independently of the API key — observed live: z-ai/glm-5.2:free
// returned 429 ("temporarily rate-limited upstream") while
// nvidia/nemotron-3-ultra-550b-a55b:free on the SAME key answered 200 in the
// same second. Unlike NIM (single vendor, one shared RPM budget), each
// OpenRouter model here routes through a different upstream provider, so a
// 429/error on one is NOT evidence the next will also fail — worth trying.
//
// Verified live against OpenRouter's current catalog (2026-08-19): pulled
// GET /models (17 total ":free" models right now), smoke-tested every
// candidate with a real chat completion. Deliberately spans multiple
// upstream providers so a single vendor incident (like the NIM stale-key
// outage this chain exists to prevent) can't take out the whole tier:
//   nvidia/nemotron-3-ultra-550b-a55b:free  200 OK, 1M ctx  (Nvidia)
//   openai/gpt-oss-20b:free                 200 OK          (OpenAI OSS weights)
//   z-ai/glm-5.2:free                       200 OK          (Zhipu)
//   nvidia/nemotron-3.5-lightning:free      200 OK          (Nvidia, fast)
//   google/gemma-4-26b-a4b-it:free          200 OK          (Google)
//   dots-studio/dots-3-note-preview:free    200 OK          (dots.llm)
//   nvidia/nemotron-3-nano-30b-a3b:free     200 OK          (Nvidia, smaller/fast)
//   google/gemma-4-31b-it:free              429 rate-limited upstream — excluded
// Order: strongest general-purpose free model first, then providers rotate,
// then deepseek-v4-flash as a paid-but-fractional-cent last resort so the
// tier still answers if every free model is down at once.
const MODEL_CHAIN = (process.env.OPENROUTER_MODEL
  ? [process.env.OPENROUTER_MODEL]
  : [
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'openai/gpt-oss-20b:free',
      'z-ai/glm-5.2:free',
      'nvidia/nemotron-3.5-lightning:free',
      'google/gemma-4-26b-a4b-it:free',
      'dots-studio/dots-3-note-preview:free',
      'nvidia/nemotron-3-nano-30b-a3b:free',
      'deepseek/deepseek-v4-flash',
    ]);
const MODEL = MODEL_CHAIN[0];

/** Status codes where trying the NEXT model in the chain is worth doing.
 *  402 = no credit for THIS (paid) model, 404 = model id retired/unknown,
 *  429 = THIS model's upstream pool is saturated — and, unlike NIM, each
 *  model here can sit behind a different upstream provider, so it is not a
 *  shared budget. 401 is the key itself and is not model-specific. */
function shouldTryNextModel(status: number): boolean {
  return status === 402 || status === 404 || status === 429;
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
      log.warn('openrouter: model unavailable, falling back', {
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
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        // OpenRouter uses these for its public leaderboard attribution only;
        // harmless to omit but recommended by their docs.
        'HTTP-Referer': 'https://app.leadrail.xyz',
        'X-Title': 'LeadRail',
      },
      body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    const err: any = new Error(
      e?.name === 'AbortError' ? `OpenRouter timed out after ${TIMEOUT_MS}ms` : `OpenRouter request failed`,
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
    throw err;
  }
  const json = await res.json();
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
): Promise<string> {
  // Same chain as complete(). Safe to fall back here because a 402/404/429
  // arrives on the response STATUS, before any delta has been emitted — so no
  // partial answer has reached the client when we switch models.
  let lastErr: any = null;
  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    try {
      return await completeStreamWith(model, messages, temperature, maxTokens, onDelta);
    } catch (err: any) {
      lastErr = err;
      const status = Number(err?.status) || 0;
      if (!shouldTryNextModel(status) || i === MODEL_CHAIN.length - 1) throw err;
      log.warn('openrouter: model unavailable (stream), falling back', {
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
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://app.leadrail.xyz',
        'X-Title': 'LeadRail',
      },
      body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens, stream: true }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    const err: any = new Error(
      e?.name === 'AbortError' ? `OpenRouter timed out after ${TIMEOUT_MS}ms` : `OpenRouter request failed`,
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
    throw err;
  }
  if (!res.body) {
    const err: any = new Error('OpenRouter returned no response stream');
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
export async function openrouterText(opts: {
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
export async function openrouterChat(opts: {
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

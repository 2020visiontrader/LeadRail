// HuggingFace Inference Providers client — OpenAI-compatible chat completions.
//
// Router tier alongside NIM and OpenRouter. HF routes a single API to many
// upstream providers (Together, Fireworks, Nebius, Cerebras, …) behind one
// OpenAI-shaped endpoint, so this is the same shape as the other tiers: a model
// chain, a timeout, and errors carrying `status` so the chain knows whether
// trying the next model can help.
//
// Free tier gives a monthly credit allowance; when it is exhausted the API
// returns 402, which is per-KEY and not survivable by switching models — so it
// is NOT in the retry set below.

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
const DEFAULT_MAX_OUT = Number(process.env.AI_MAX_OUTPUT_TOKENS) || 16000;

import { readSseDeltas } from './opencode';
import { reportOpenAIUsage } from './usage';
import { parseRetryAfterMs } from './health';

const BASE = 'https://router.huggingface.co/v1';
const KEY = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || '';

// Ordered chain, same reasoning as NIM's: providers rotate what they serve, and
// a model that 404s today should not take the whole tier down. HF_MODEL wins.
//
// Verified live against HuggingFace's Inference Providers router (2026-08-19):
// smoke-tested each candidate with a real chat completion. Several plausible
// ids 400'd as "does not exist" for this provider route (Mistral-Small-24B,
// gemma-2-27b-it, Phi-4, Hermes-3, QwQ-32B, Llama-3.2-3B, zephyr-7b-beta,
// Yi-1.5-34B) and were excluded rather than guessed back in. Spans DeepSeek,
// Qwen, Meta, and Moonshot so one upstream provider rotation can't take the
// whole tier down.
export const MODEL_CHAIN = (process.env.HF_MODEL
  ? [process.env.HF_MODEL]
  : [
      // ── ORDERED BY MEASURED LATENCY (probe 2026-08-19). 8/8 answered.
      // Led with Qwen3-235B (386ms); Llama-3.3-70B answers in 223ms.
      // The whole tier is healthy, so this is pure ordering, not triage.
      'meta-llama/Llama-3.3-70B-Instruct',
      'meta-llama/Llama-3.1-8B-Instruct',
      'Qwen/Qwen3-235B-A22B-Instruct-2507',
      'meta-llama/Llama-4-Scout-17B-16E-Instruct',
      'Qwen/Qwen2.5-Coder-32B-Instruct',
      'moonshotai/Kimi-K2-Instruct',
      'deepseek-ai/DeepSeek-V3.2-Exp',
      'deepseek-ai/DeepSeek-V3.1',
      // ── Verified present in the provider catalog, not yet latency-tested.
      'deepseek-ai/DeepSeek-V4-Pro-0813',
      'deepseek-ai/DeepSeek-V4-Flash-0731',
      'moonshotai/Kimi-K3',
      'zai-org/GLM-5.2',
      'deepseek-ai/DeepSeek-V4-Pro',
      'deepseek-ai/DeepSeek-V4-Flash',
      'thinkingmachines/Inkling-Small',
      'thinkingmachines/Inkling',
      'XiaomiMiMo/MiMo-V2.5-Pro',
    ]);

// 20s: this is a fallback tier, and a slow tier that eventually answers is worse
// than a fast one that declines — the router still has OpenRouter after it.
const TIMEOUT_MS = Number(process.env.HF_TIMEOUT_MS) || 20_000;

/** 404 = model not served by any provider right now; 403 = no access to this
 *  model. Both are per-MODEL and survivable. 401 (bad token) and 402 (credits
 *  exhausted) are per-KEY — another model cannot help, so do not retry. */
function shouldTryNextModel(status: number): boolean {
  return status === 404 || status === 403;
}

export function huggingfaceConfigured(): boolean {
  return KEY.length > 0;
}

interface Msg { role: 'system' | 'user' | 'assistant'; content: string }

async function callHF(
  model: string,
  messages: Msg[],
  temperature: number,
  maxTokens: number,
  stream: boolean,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages, temperature, max_tokens: maxTokens, stream,
        // Only meaningful when streaming; a non-streaming response carries
        // `usage` unconditionally. See readSseDeltas.
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    const err: any = new Error(
      e?.name === 'AbortError' ? `HuggingFace timed out after ${TIMEOUT_MS}ms` : 'HuggingFace request failed',
    );
    err.code = 'upstream';
    err.detail = String(e?.message || e).slice(0, 300);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function throwForResponse(res: Response, model: string, detail: string): never {
  const err: any = new Error(`HuggingFace failed (${res.status}) model=${model}${detail ? ` — ${detail}` : ''}`);
  err.code = res.status === 401 || res.status === 402 || res.status === 403 ? 'auth' : 'upstream';
  err.status = res.status;
  err.detail = detail;
  // 402 here is the monthly-credit-depleted case documented above — 429 is a
  // separate, survivable, per-request rate limit. Only the latter carries a
  // Retry-After the taxonomy in lib/ai/health.ts can honour.
  if (res.status === 429) err.retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
  throw err;
}

async function complete(messages: Msg[], temperature: number, maxTokens: number): Promise<string> {
  let lastErr: any = null;
  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    try {
      const res = await callHF(model, messages, temperature, maxTokens, false);
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throwForResponse(res, model, detail);
      }
      const json: any = await res.json();
      reportOpenAIUsage(json);
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        const err: any = new Error(`HuggingFace returned an empty response (model=${model})`);
        err.code = 'upstream';
        throw err;
      }
      return text;
    } catch (err: any) {
      lastErr = err;
      const status = Number(err?.status) || 0;
      if (!shouldTryNextModel(status) || i === MODEL_CHAIN.length - 1) throw err;
    }
  }
  throw lastErr;
}

export async function hfText(opts: { system?: string; prompt: string; temperature?: number; maxOutputTokens?: number }): Promise<string> {
  const messages: Msg[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });
  return complete(messages, opts.temperature ?? 0.4, opts.maxOutputTokens ?? DEFAULT_MAX_OUT);
}

export async function hfChat(opts: { system?: string; messages: Msg[]; temperature?: number; maxOutputTokens?: number }): Promise<string> {
  const messages: Msg[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push(...opts.messages);
  return complete(messages, opts.temperature ?? 0.4, opts.maxOutputTokens ?? DEFAULT_MAX_OUT);
}

export async function hfStreamChat(
  opts: { system?: string; messages: Msg[]; temperature?: number; maxOutputTokens?: number },
  onDelta: (chunk: string) => void,
): Promise<string> {
  const messages: Msg[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push(...opts.messages);

  // Falls back to the first model only for streaming: switching models mid-stream
  // after deltas have been emitted would splice two different answers together.
  const model = MODEL_CHAIN[0];
  const res = await callHF(model, messages, opts.temperature ?? 0.4, opts.maxOutputTokens ?? DEFAULT_MAX_OUT, true);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throwForResponse(res, model, detail);
  }
  if (!res.body) {
    const err: any = new Error('HuggingFace returned no stream body');
    err.code = 'upstream';
    throw err;
  }
  // readSseDeltas hands back the PARSED event, not a text chunk, and returns
  // void — so accumulate here, same as openrouter.ts does.
  let full = '';
  await readSseDeltas(res.body, (evt: any) => {
    const chunk = evt?.choices?.[0]?.delta?.content;
    if (typeof chunk === 'string' && chunk) { full += chunk; onDelta(chunk); }
  });
  if (!full.trim()) {
    const err: any = new Error('HuggingFace stream produced no content');
    err.code = 'upstream';
    throw err;
  }
  return full;
}

/** Call ONE specific model directly, bypassing the chain (see probeNimModel). */
export async function probeHfModel(model: string): Promise<string> {
  const res = await callHF(model, [{ role: 'user', content: 'Reply with one word: ok' }], 0, 16, false);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throwForResponse(res, model, detail);
  }
  const json: any = await res.json();
  return String(json?.choices?.[0]?.message?.content ?? '').trim();
}

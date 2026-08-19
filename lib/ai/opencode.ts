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

async function complete(messages: OpenAIMessage[], temperature: number, maxTokens: number, model?: string): Promise<string> {
  requireKey();
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
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    const err: any = new Error(
      e?.name === 'AbortError' ? `OpenCode timed out after ${TIMEOUT_MS}ms` : `OpenCode request failed`,
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
    err.detail = detail;
    throw err;
  }
  const json = await res.json();
  // DeepSeek returns the answer in message.content; reasoning_content is separate
  // scratch and is deliberately ignored.
  const content = json?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';

  // Self-heal: some Go models (kimi/qwen/glm/...) reason uncontrollably on this
  // endpoint and return EMPTY content. If that happens on a non-DeepSeek model,
  // retry once on the reliable DeepSeek backbone (thinking disabled) so a caller
  // never receives a blank. DeepSeek emptiness is a real failure — don't loop.
  if (!text && !/deepseek/i.test(useModel)) {
    return complete(messages, temperature, maxTokens, RELIABLE_FALLBACK);
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

  const handleLine = (raw: string) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try { onEvent(JSON.parse(payload)); } catch { /* skip a malformed frame */ }
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
): Promise<string> {
  requireKey();
  const useModel = model || TEXT_MODEL;
  const body: Record<string, any> = {
    model: useModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
  };
  // Same DeepSeek rule as complete(): thinking ON burns the whole budget on
  // hidden reasoning_content and returns nothing usable.
  if (/deepseek/i.test(useModel)) body.thinking = { type: 'disabled' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    const err: any = new Error(
      e?.name === 'AbortError' ? `OpenCode timed out after ${TIMEOUT_MS}ms` : `OpenCode request failed`,
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
    err.detail = detail;
    throw err;
  }
  if (!res.body) {
    const err: any = new Error('OpenCode returned no response stream');
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
  },
  onDelta: (chunk: string) => void,
): Promise<string> {
  const messages: OpenAIMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) {
    if (m.content?.trim()) messages.push({ role: m.role, content: m.content });
  }
  return completeStream(messages, opts.temperature ?? 0.6, opts.maxOutputTokens ?? DEFAULT_MAX_OUT, opts.model, onDelta);
}

/** Generate text. Returns the model's plain-text completion. Pass `model` to
 * override the default (Hermes routes different tasks to different Go models). */
export async function generateText(opts: {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
}): Promise<string> {
  const messages: OpenAIMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });
  return complete(messages, opts.temperature ?? 0.7, opts.maxOutputTokens ?? DEFAULT_MAX_OUT, opts.model);
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
}): Promise<string> {
  const messages: OpenAIMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) {
    if (m.content?.trim()) messages.push({ role: m.role, content: m.content });
  }
  return complete(messages, opts.temperature ?? 0.6, opts.maxOutputTokens ?? DEFAULT_MAX_OUT, opts.model);
}

export const opencodeModel = TEXT_MODEL;

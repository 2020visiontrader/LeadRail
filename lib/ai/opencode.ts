// OpenCode Go client — text + multi-turn chat via DeepSeek V4 Pro.
// OpenAI-compatible Chat Completions endpoint. Draws on the OpenCode Go
// subscription (not Zen pay-per-use credits). Admin/account-scoped generation
// only; a route handler invokes it on explicit request. Image generation stays
// on Gemini (see ./gemini) — OpenCode returns text, not image bytes.

const KEY =
  process.env.OPENCODE_API_KEY ||
  process.env.OpenCode_Api_Key ||
  process.env.OPENCODE_GO_API_KEY ||
  '';
// Base + model are env-overridable so the model can be swapped without a code
// change. Defaults track the OpenCode Go DeepSeek V4 Pro endpoint.
const BASE = (process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/go/v1').replace(/\/$/, '');
const TEXT_MODEL = process.env.OPENCODE_MODEL || 'deepseek-v4-pro';

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

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  return typeof content === 'string' ? content.trim() : '';
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
  return complete(messages, opts.temperature ?? 0.7, opts.maxOutputTokens ?? 2048, opts.model);
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
  return complete(messages, opts.temperature ?? 0.6, opts.maxOutputTokens ?? 2048, opts.model);
}

export const opencodeModel = TEXT_MODEL;

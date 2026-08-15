// NVIDIA NIM client — OpenAI-compatible Chat Completions. Last-resort tier of
// the AI routing ladder (see ./router): reached only when Ask Zo and OpenCode
// Go both fail or are unconfigured. Text/chat only; images stay on Gemini.

const KEY = process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY || '';
const BASE = 'https://integrate.api.nvidia.com/v1';
const MODEL = process.env.NIM_MODEL || 'meta/llama-3.1-8b-instruct';

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

async function complete(messages: OpenAIMessage[], temperature: number, maxTokens: number): Promise<string> {
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
    const err: any = new Error(`NIM failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = detail;
    throw err;
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
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
// Zo Ask client — text + multi-turn chat via the user's BYOK subscription model.
// Primary tier of the AI routing ladder (see ./router). Calls the Zo Ask HTTP
// endpoint with a BYOK model id; on error/timeout the router falls through to
// OpenCode Go, then NVIDIA NIM. Admin/account-scoped generation only.

const KEY =
  process.env.ZO_Api_Key ||
  process.env.ZO_API_KEY ||
  process.env.ZO_CLIENT_IDENTITY_TOKEN ||
  '';

// Optional model override. When ZOASK_MODEL is unset, `model_name` is omitted
// from the request so Zo Ask uses the account's default model (currently Opus,
// Haiku once the user sets it). Set ZOASK_MODEL to a `byok:` id to override.
const MODEL = process.env.ZOASK_MODEL;

// Hard timeout so a stalled subscription call fails over to OpenCode/NIM
// instead of blocking the whole request. Haiku answers in ~2-3s, Opus in
// ~15-20s on a short prompt — but the agent's routing pass now runs here too,
// on a prompt carrying the tool catalog, the grounding block and a long
// transcript, where Opus legitimately takes considerably longer. At 40s those
// calls were being aborted and silently answered by the next tier down, which
// is the worst outcome available: the latency of the good model was paid and
// the cheap model's answer was shipped. Override with ZOASK_TIMEOUT_MS.
const TIMEOUT_MS = Number(process.env.ZOASK_TIMEOUT_MS) || 120_000;

export function zoAskConfigured(): boolean {
  // Model is optional (defaults to the account model), so token presence alone
  // means configured.
  return KEY.length > 0;
}

// Model ids that mean "use whatever the Zo account is set to" rather than
// naming a model on the wire.
//
// `__default__` is the `ai_models.model_id` of the registry's
// "Zo Ask (account default)" row (migration 023_ai_providers.sql). It is a
// SENTINEL, and until now nothing read it as one: lib/ai/providers.ts passes
// `model: model.model_id` straight into zoAskChat, so every account-registry
// chat call posted `{"input": "...", "model_name": "__default__"}` and Zo Ask
// answered 502. That is the whole of the "Zo Ask outage" — 76 consecutive
// failures on the registry path while the ladder path, which passes no model
// and so omits the field, logged 31 successes against the same key in the same
// minutes.
//
// This is the right boundary for the check: it is where a stored id becomes a
// wire value, so it also covers any future caller that forwards the sentinel.
const DEFAULT_MODEL_SENTINELS = new Set(['__default__', 'default', 'auto', '']);

async function ask(input: string, modelOverride?: string): Promise<string> {
  const model = modelOverride || MODEL;
  const body: { input: string; model_name?: string } = { input };
  if (typeof model === 'string' && !DEFAULT_MODEL_SENTINELS.has(model.trim())) {
    body.model_name = model;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch('https://api.zo.computer/zo/ask', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    const err: any = new Error(
      e?.name === 'AbortError' ? `Zo Ask timed out after ${TIMEOUT_MS}ms` : `Zo Ask request failed`,
    );
    err.code = 'upstream';
    err.detail = String(e?.message || e).slice(0, 300);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`Zo Ask failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = detail;
    throw err;
  }
  const json = await res.json();
  // `output` may be a plain string or a structured object.
  const output = json?.output;
  const text =
    typeof output === 'string'
      ? output.trim()
      : output != null
        ? JSON.stringify(output).trim()
        : '';
  if (!text) {
    const err: any = new Error('Zo Ask returned empty output');
    err.code = 'upstream';
    err.detail = JSON.stringify(json ?? {}).slice(0, 300);
    throw err;
  }
  return text;
}

/** Generate text. system (if any) is prepended to the prompt as the `input`. */
export async function zoAskText(opts: {
  system?: string;
  prompt: string;
  maxOutputTokens?: number;
}): Promise<string> {
  const input = opts.system ? `${opts.system}\n\n${opts.prompt}` : opts.prompt;
  return ask(input);
}

/**
 * Multi-turn chat. Zo Ask takes a single `input` string, so the conversation is
 * flattened to a transcript: optional system line, then each message labelled
 * "User:"/"Assistant:", then a trailing "Assistant:" to cue the completion.
 */
export async function zoAskChat(opts: {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxOutputTokens?: number;
  model?: string;
}): Promise<string> {
  const lines: string[] = [];
  if (opts.system) lines.push(opts.system);
  for (const m of opts.messages) {
    if (!m.content?.trim()) continue;
    lines.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
  }
  lines.push('Assistant:');
  return ask(lines.join('\n'), opts.model);
}
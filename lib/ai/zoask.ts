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
// ~15-20s; 40s covers the slow default while leaving room under the frontend
// guard for the remaining tiers. Override with ZOASK_TIMEOUT_MS.
const TIMEOUT_MS = Number(process.env.ZOASK_TIMEOUT_MS) || 40_000;

export function zoAskConfigured(): boolean {
  // Model is optional (defaults to the account model), so token presence alone
  // means configured.
  return KEY.length > 0;
}

async function ask(input: string): Promise<string> {
  const body: { input: string; model_name?: string } = { input };
  if (typeof MODEL === 'string' && MODEL.length > 0) {
    body.model_name = MODEL;
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
}): Promise<string> {
  const lines: string[] = [];
  if (opts.system) lines.push(opts.system);
  for (const m of opts.messages) {
    if (!m.content?.trim()) continue;
    lines.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
  }
  lines.push('Assistant:');
  return ask(lines.join('\n'));
}
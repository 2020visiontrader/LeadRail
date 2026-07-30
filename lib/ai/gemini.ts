// Gemini client — text (Gemini Flash) + static image (Nano Banana / Gemini image).
// Admin/account-scoped generation only. Never called automatically; a route
// handler invokes it on explicit request. Reads the key from Zo secrets.

const KEY = process.env.Gemini_api_key || process.env.GEMINI_API_KEY || '';
// Model ids are env-overridable so the exact Flash / Nano-Banana version can be
// tuned without a code change. Defaults track the current GA ids.
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function geminiConfigured(): boolean {
  return KEY.length > 0;
}

function requireKey() {
  if (!KEY) {
    const err: any = new Error('Gemini is not connected');
    err.code = 'not_configured';
    throw err;
  }
}

/** Generate text. Returns the model's plain-text completion. */
export async function generateText(opts: {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<string> {
  requireKey();
  const body: Record<string, any> = {
    contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
    },
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

  const res = await fetch(`${BASE}/models/${TEXT_MODEL}:generateContent?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`Gemini text failed (${res.status})`);
    err.code = res.status === 400 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = detail;
    throw err;
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: any) => p.text || '').join('').trim();
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Multi-turn chat completion. Passes the whole conversation to Gemini so the
 * model can ask clarifying questions and refine across turns. Maps our
 * user/assistant roles to Gemini's user/model roles.
 */
export async function generateChat(opts: {
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<string> {
  requireKey();
  const contents = opts.messages
    .filter((m) => m.content?.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body: Record<string, any> = {
    contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.6,
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
    },
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

  const res = await fetch(`${BASE}/models/${TEXT_MODEL}:generateContent?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`Gemini chat failed (${res.status})`);
    err.code = res.status === 400 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = detail;
    throw err;
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: any) => p.text || '').join('').trim();
}

export interface GeneratedImage {
  mimeType: string;
  base64: string; // raw base64 image bytes
}

/**
 * Generate a static image via Nano Banana. Caption overlays are rendered by the
 * model itself (baked into the image) when `caption` is supplied — no external
 * compositing dependency. Static only; video is out of scope.
 */
export async function generateImage(opts: {
  prompt: string;
  caption?: string;
  aspect?: string; // e.g. "1:1", "16:9", "4:5"
}): Promise<GeneratedImage> {
  requireKey();
  let prompt = opts.prompt;
  if (opts.aspect) prompt += `\n\nAspect ratio: ${opts.aspect}.`;
  if (opts.caption) {
    prompt +=
      `\n\nRender this exact caption as a clean, legible text overlay on the image` +
      ` (high-contrast, professional ad typography, no misspellings): "${opts.caption}".`;
  }

  const res = await fetch(`${BASE}/models/${IMAGE_MODEL}:generateContent?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`Gemini image failed (${res.status})`);
    err.code = res.status === 400 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = detail;
    throw err;
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p: any) => p.inlineData?.data);
  if (!img) {
    const err: any = new Error('Gemini returned no image');
    err.code = 'upstream';
    err.detail = JSON.stringify(json).slice(0, 300);
    throw err;
  }
  return { mimeType: img.inlineData.mimeType || 'image/png', base64: img.inlineData.data };
}

export const geminiModels = { text: TEXT_MODEL, image: IMAGE_MODEL };

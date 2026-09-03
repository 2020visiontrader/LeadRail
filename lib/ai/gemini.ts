// Gemini client — text (Gemini Flash) + static image (Nano Banana / Gemini image).
// Admin/account-scoped generation only. Never called automatically; a route
// handler invokes it on explicit request. Reads the key from Zo secrets.

import { StoppedError } from './abort';

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
  /** External abort, e.g. an in-flight cooperative stop (lib/agent/
   *  stop-watch.ts). Optional/additive — omitted, behaviour is unchanged.
   *  Unlike zoask/opencode/nim there is no existing internal timeout
   *  AbortController here to combine it with, so it is passed straight
   *  through as the fetch's own signal — the least invasive addition
   *  consistent with those clients' pattern. */
  signal?: AbortSignal;
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

  let res: Response;
  try {
    res = await fetch(`${BASE}/models/${TEXT_MODEL}:generateContent?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e: any) {
    if (opts.signal?.aborted) throw new StoppedError('Gemini call aborted: stop requested');
    throw e;
  }
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
  /** External abort — see generateText's matching comment above. */
  signal?: AbortSignal;
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

  let res: Response;
  try {
    res = await fetch(`${BASE}/models/${TEXT_MODEL}:generateContent?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e: any) {
    if (opts.signal?.aborted) throw new StoppedError('Gemini call aborted: stop requested');
    throw e;
  }
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

/** Fetch a reference image and return it as an inline data part.
 *
 *  Image-conditioning is what makes a recurring character stay the same
 *  character. Text-to-image re-invents them on every call — different face,
 *  different wardrobe, different style — so a brand avatar drifts visibly from
 *  post to post. Passing the anchor image alongside the prompt is the fix, and
 *  it is not a prompt-engineering trick: the model is given the actual pixels.
 *
 *  Bounded on purpose: a reference that is unreachable, oversized, or not an
 *  image throws rather than silently degrading to text-to-image, because a
 *  silent fallback produces exactly the drift this exists to prevent.
 */
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

async function referencePart(url: string): Promise<{ inlineData: { mimeType: string; data: string } }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the reference image (${res.status}).`);
  const mimeType = res.headers.get('content-type') || 'image/png';
  if (!mimeType.startsWith('image/')) throw new Error(`The reference URL is not an image (${mimeType}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_REFERENCE_BYTES) throw new Error('The reference image is too large (limit 8MB).');
  return { inlineData: { mimeType, data: buf.toString('base64') } };
}

/**
 * Generate a static image via Nano Banana. Caption overlays are rendered by the
 * model itself (baked into the image) when `caption` is supplied — no external
 * compositing dependency. Static only; video is out of scope.
 *
 * `referenceUrls` switches this from text-to-image to image-conditioned
 * generation: the references are sent as pixels and the prompt describes only
 * what CHANGES. That is the whole avatar-consistency system — generate the
 * character sheet once, then condition every later scene on it.
 */
export async function generateImage(opts: {
  prompt: string;
  caption?: string;
  aspect?: string; // e.g. "1:1", "16:9", "4:5"
  referenceUrls?: string[];
  /** Appended verbatim after everything else, e.g. a brand style lock. */
  styleLock?: string;
}): Promise<GeneratedImage> {
  requireKey();
  let prompt = opts.prompt;
  if (opts.aspect) prompt += `\n\nAspect ratio: ${opts.aspect}.`;
  if (opts.caption) {
    prompt +=
      `\n\nRender this exact caption as a clean, legible text overlay on the image` +
      ` (high-contrast, professional ad typography, no misspellings): "${opts.caption}".`;
  }
  const refs = opts.referenceUrls?.length
    ? await Promise.all(opts.referenceUrls.slice(0, 4).map(referencePart))
    : [];
  if (refs.length) {
    prompt +=
      `\n\nThe attached image${refs.length > 1 ? 's are' : ' is'} the reference for the subject's identity` +
      ` — face, build, wardrobe and art style. Keep all of that IDENTICAL. Change only the scene described above.` +
      ` Do not reinterpret or restyle the character.`;
  }
  if (opts.styleLock) prompt += `\n\n${opts.styleLock}`;

  const res = await fetch(`${BASE}/models/${IMAGE_MODEL}:generateContent?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // References first, prompt last: the trailing text is what the model
    // treats as the instruction acting ON the preceding images.
    body: JSON.stringify({ contents: [{ role: 'user', parts: [...refs, { text: prompt }] }] }),
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

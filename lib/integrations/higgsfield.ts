// Higgsfield — video generation.
//
// LeadRail had no video generation at all. Every content plan in this workspace
// is built on short-form video (10s vertical, avatar-fronted, native lip-sync),
// and the platform could produce stills and nothing else — so the engine could
// plan a content calendar it was structurally unable to execute.
//
// Shape of the API (platform.higgsfield.ai):
//   auth    Authorization: Key <KEY_ID>:<KEY_SECRET>
//   submit  POST /v1/image2video/dop        -> { id }
//   poll    GET  /requests/{id}/status      -> { status, ... }
//   status  queued | in_progress | completed | failed | nsfw
//   result  jobSet.jobs[0].results.raw.url
//
// IMAGE-TO-VIDEO, deliberately. Higgsfield's strength here is animating a
// still, and that composes with the avatar system: the character reference
// produces a consistent frame, and this animates THAT frame — so the person in
// the video is the same person as in the stills. Text-to-video would re-invent
// them, which is the drift lib/ai/gemini.ts's reference conditioning exists to
// stop.

const BASE = process.env.HIGGSFIELD_BASE_URL || 'https://platform.higgsfield.ai';

/** Accepts the combined "KEY_ID:KEY_SECRET" form, or the two halves separately. */
function credentials(): string | undefined {
  const combined = process.env.HIGGSFIELD_API_KEY || process.env.Higgsfield_Api_Key;
  if (combined && combined.includes(':')) return combined;
  const id = process.env.HIGGSFIELD_KEY_ID;
  const secret = process.env.HIGGSFIELD_KEY_SECRET;
  if (id && secret) return `${id}:${secret}`;
  return undefined;
}

export function higgsfieldConfigured(): boolean {
  return Boolean(credentials());
}

function authHeaders(): Record<string, string> {
  const creds = credentials();
  if (!creds) {
    const err: any = new Error('Video generation is not connected — set HIGGSFIELD_API_KEY as "KEY_ID:KEY_SECRET".');
    err.code = 'not_configured';
    throw err;
  }
  return { authorization: `Key ${creds}`, 'content-type': 'application/json' };
}

export interface VideoResult {
  url: string;
  requestId: string;
  model: string;
}

export type VideoStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw';

async function submit(path: string, input: Record<string, any>): Promise<string> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ input }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Video generation failed (${res.status}): ${(json as any)?.message || res.statusText}`);
  }
  const id = (json as any)?.id || (json as any)?.request_id;
  if (!id) throw new Error('Video generation returned no request id.');
  return String(id);
}

/** Read one request's state. Exported so a caller can resume a poll after a
 *  timeout instead of paying for the generation twice. */
export async function getVideoStatus(requestId: string): Promise<{ status: VideoStatus; url: string | null; raw: any }> {
  const res = await fetch(`${BASE}/requests/${encodeURIComponent(requestId)}/status`, { headers: authHeaders() });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Could not read video status (${res.status}): ${json?.message || res.statusText}`);
  const status = String(json?.status || 'queued') as VideoStatus;
  const url = json?.jobSet?.jobs?.[0]?.results?.raw?.url ?? json?.results?.raw?.url ?? null;
  return { status, url: url ? String(url) : null, raw: json };
}

/**
 * Poll until the render finishes.
 *
 * A video render is minutes, not seconds, so the ceiling here is generous and
 * the failure is explicit: on timeout the requestId is thrown back in the
 * message, because the render is still running and still being paid for —
 * losing the id would mean re-submitting rather than resuming.
 */
async function poll(requestId: string, timeoutMs: number, intervalMs = 4000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, url } = await getVideoStatus(requestId);
    if (status === 'completed') {
      if (!url) throw new Error('The render completed but returned no video URL.');
      return url;
    }
    if (status === 'failed') throw new Error('The video render failed upstream.');
    if (status === 'nsfw') throw new Error('The render was rejected by the provider\'s content filter. Rewrite the prompt.');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `The video is still rendering after ${Math.round(timeoutMs / 1000)}s. It has not been lost — check on it with request id ${requestId}.`,
  );
}

export interface GenerateVideoInput {
  /** The still to animate. Pair this with a character reference so the person
   *  in the video is the same person as in the stills. */
  imageUrl: string;
  /** What MOVES — camera motion, gesture, the action. Not who the subject is;
   *  that is already fixed by the image. */
  prompt: string;
  /** Spoken line for native lip-sync, when the model supports it. */
  dialogue?: string;
  model?: string;
  timeoutMs?: number;
}

/** Animate a still into a short video, waiting for the result. */
export async function generateVideo(input: GenerateVideoInput): Promise<VideoResult> {
  const model = input.model || process.env.HIGGSFIELD_MODEL || 'dop-turbo';
  const prompt = input.dialogue
    ? `${input.prompt}\n\nThe subject speaks this line to camera, lip-synced: "${input.dialogue}"`
    : input.prompt;
  const requestId = await submit('/v1/image2video/dop', {
    model,
    prompt,
    input_images: [{ type: 'image_url', image_url: input.imageUrl }],
  });
  const url = await poll(requestId, input.timeoutMs ?? 300_000);
  return { url, requestId, model };
}

/** Submit without waiting. For a batch, where blocking a turn per render would
 *  make the whole run time out. */
export async function submitVideo(input: GenerateVideoInput): Promise<{ requestId: string; model: string }> {
  const model = input.model || process.env.HIGGSFIELD_MODEL || 'dop-turbo';
  const prompt = input.dialogue
    ? `${input.prompt}\n\nThe subject speaks this line to camera, lip-synced: "${input.dialogue}"`
    : input.prompt;
  const requestId = await submit('/v1/image2video/dop', {
    model,
    prompt,
    input_images: [{ type: 'image_url', image_url: input.imageUrl }],
  });
  return { requestId, model };
}

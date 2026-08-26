// Speech to text — the microphone in the composer.
//
// TWO ENGINES, TRIED IN ORDER. ElevenLabs Scribe is the primary: best
// accuracy of the options evaluated, and diarization/timestamps for later if
// the product wants them. Its API is NOT the open Whisper-shaped contract —
// it wants an `xi-api-key` header and a `model_id` field, not `Authorization:
// Bearer` and `model` — so it gets its own request builder rather than being
// forced into the generic one.
//
// The generic engine (below) targets the OTHER contract: practically every
// open-source speech-to-text server converged on POST multipart to
// /v1/audio/transcriptions with `file` + `model`, get back {text}.
// whisper.cpp's server, faster-whisper-server, Speaches, vLLM's audio
// endpoint, Groq and Hugging Face's router all speak it — so this one file
// has no vendor baked into it and works with whichever of those you run.
//
// When ElevenLabs fails for ANY reason — out of credits, a bad key, a
// transient outage — the request falls through to the generic engine rather
// than surfacing the failure to whoever just spoke. That is the whole point
// of configuring both: a voice note should not die because one vendor had a
// bad five minutes.
//
// A NOTE ON WHAT NOT TO USE. The browser's built-in SpeechRecognition API is
// tempting — zero infrastructure, one line of JavaScript — and it is the wrong
// choice twice over. It only exists in Chromium, so it silently does nothing
// for Safari and Firefox users. And in Chrome it streams the audio to Google's
// servers, which is a third party receiving your operators' voice notes
// without ever appearing in a privacy policy or a sub-processor list. That is
// the kind of dependency that is invisible until it is a compliance problem.

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || 'scribe_v1';
// Overridable only so tests can point this at a local mock server without
// touching real ElevenLabs infrastructure. Never set ELEVENLABS_URL in a real
// deployment — there is only one ElevenLabs endpoint.
const ELEVENLABS_URL = process.env.ELEVENLABS_URL || 'https://api.elevenlabs.io/v1/speech-to-text';

const TRANSCRIBE_URL = process.env.TRANSCRIBE_URL || '';
const TRANSCRIBE_KEY = process.env.TRANSCRIBE_API_KEY || '';
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';

/** Long enough for a real brain-dump, bounded so a stuck request cannot hold a
 *  serverless invocation open until it is killed without explanation. */
const TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS) || 120_000;

/** Roughly ten minutes of speech at a sane bitrate. A cap belongs here rather
 *  than only in the browser: the browser's limit is a suggestion to anyone
 *  posting directly. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function elevenLabsConfigured(): boolean {
  return Boolean(ELEVENLABS_KEY);
}

function genericConfigured(): boolean {
  return Boolean(TRANSCRIBE_URL);
}

export function transcribeConfigured(): boolean {
  return elevenLabsConfigured() || genericConfigured();
}

export interface Transcription {
  text: string;
  /** Seconds of audio, when the engine reports it. Not all do. */
  duration?: number;
  model: string;
  /** Which engine actually served this request — 'elevenlabs' or 'generic'.
   *  Not shown to the person who spoke; it is here so a fallback shows up in
   *  logs instead of only in ElevenLabs' own dashboard. */
  provider: 'elevenlabs' | 'generic';
}

interface TranscribeInput {
  bytes: Buffer;
  filename?: string;
  mimeType?: string;
  /** ISO-639-1. Supplying it measurably improves accuracy and speed; when it is
   *  absent the engine detects, which is usually right and occasionally
   *  produces a confidently wrong language. */
  language?: string;
  /** Domain vocabulary — brand names, product names, jargon. Whisper-family
   *  models take this as a prior, and it is the single cheapest accuracy win
   *  available: without it, a venture called "Zoask" comes back as "zo ask",
   *  "so ask", or "Zoe asked". ElevenLabs' batch endpoint has no equivalent
   *  field as of scribe_v1, so this only reaches the generic engine. */
  prompt?: string;
}

function audioBlob(input: TranscribeInput): Blob {
  // The extension is load-bearing: several engines pick their decoder from the
  // filename rather than the content type, and a mismatched one fails with an
  // opaque decode error rather than an obvious rejection.
  return new Blob([new Uint8Array(input.bytes)], { type: input.mimeType || 'audio/webm' });
}

async function callElevenLabs(input: TranscribeInput): Promise<Transcription> {
  const form = new FormData();
  form.append('file', audioBlob(input), input.filename || 'audio.webm');
  form.append('model_id', ELEVENLABS_MODEL);
  if (input.language) form.append('language_code', input.language);

  const controller = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ELEVENLABS_URL, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_KEY },
      body: form,
      signal: controller,
    });
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error('ElevenLabs took too long and was stopped.');
    }
    throw new Error('Could not reach ElevenLabs.');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  const json: any = await res.json().catch(() => null);
  const text = typeof json?.text === 'string' ? json.text.trim() : '';
  if (!text) throw new Error('ElevenLabs returned nothing — the recording may have been silent.');

  return {
    text,
    duration: typeof json?.audio_duration_secs === 'number' ? json.audio_duration_secs : undefined,
    model: ELEVENLABS_MODEL,
    provider: 'elevenlabs',
  };
}

async function callGeneric(input: TranscribeInput): Promise<Transcription> {
  const form = new FormData();
  form.append('file', audioBlob(input), input.filename || 'audio.webm');
  form.append('model', TRANSCRIBE_MODEL);
  if (input.language) form.append('language', input.language);
  if (input.prompt) form.append('prompt', input.prompt.slice(0, 800));
  form.append('response_format', 'json');

  const controller = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(TRANSCRIBE_URL, {
      method: 'POST',
      headers: TRANSCRIBE_KEY ? { Authorization: `Bearer ${TRANSCRIBE_KEY}` } : {},
      body: form,
      signal: controller,
    });
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error('Transcription took too long and was stopped. A shorter recording will usually go through.');
    }
    throw new Error('Could not reach the transcription service.');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Truncated: an engine's error body can be a stack trace, and pasting one
    // into the composer is not an error message.
    throw new Error(`Transcription failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  const json: any = await res.json().catch(() => null);
  const text = typeof json?.text === 'string' ? json.text.trim() : '';
  if (!text) {
    // A genuinely empty result usually means silence or a dead microphone, and
    // saying so beats handing back an empty box.
    throw new Error('Nothing was transcribed — the recording may have been silent, or the wrong microphone was used.');
  }

  return {
    text,
    duration: typeof json?.duration === 'number' ? json.duration : undefined,
    model: TRANSCRIBE_MODEL,
    provider: 'generic',
  };
}

/**
 * Turn recorded audio into text.
 *
 * Tries ElevenLabs first when configured, falls back to the generic engine
 * (Groq or self-hosted) on any failure. Throws with a message meant for the
 * person who just spoke, because that is who sees it.
 */
export async function transcribeAudio(input: TranscribeInput): Promise<Transcription> {
  if (!transcribeConfigured()) {
    throw new Error(
      'Voice input is not set up on this deployment. Set TRANSCRIBE_URL to a speech-to-text endpoint (any Whisper-compatible server) and redeploy.',
    );
  }
  if (!input.bytes?.length) throw new Error('The recording was empty — nothing was captured.');
  if (input.bytes.length > MAX_AUDIO_BYTES) {
    throw new Error('That recording is too long. Keep voice notes under about ten minutes.');
  }

  const attempts: Array<() => Promise<Transcription>> = [];
  if (elevenLabsConfigured()) attempts.push(() => callElevenLabs(input));
  if (genericConfigured()) attempts.push(() => callGeneric(input));

  let lastError: Error | null = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const result = await attempts[i]();
      if (i > 0) {
        // A fallback was used — worth a line in the logs, not in the UI.
        console.warn(`[transcribe] primary engine failed, served by ${result.provider}: ${lastError?.message}`);
      }
      return result;
    } catch (e: any) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastError || new Error('Could not transcribe that.');
}

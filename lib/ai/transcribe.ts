// Speech to text — the microphone in the composer.
//
// WHY THIS TARGETS AN API SHAPE RATHER THAN A PRODUCT. Practically every
// open-source speech-to-text server converged on the same HTTP contract:
// POST multipart to /v1/audio/transcriptions with a `file` and a `model`, get
// back {text}. whisper.cpp's server, faster-whisper-server, Speaches, vLLM's
// audio endpoint, Groq and Hugging Face's router all speak it.
//
// So this file has no vendor in it. Point TRANSCRIBE_URL at whichever engine
// you run — a container on your own hardware, or a hosted endpoint — and it
// works. That matters here because the choice is genuinely open: self-hosting
// keeps voice notes off third-party infrastructure, which for a tool holding a
// CRM is a real consideration, while a hosted endpoint is running in a minute.
// Neither belongs baked into the code.
//
// A NOTE ON WHAT NOT TO USE. The browser's built-in SpeechRecognition API is
// tempting — zero infrastructure, one line of JavaScript — and it is the wrong
// choice twice over. It only exists in Chromium, so it silently does nothing
// for Safari and Firefox users. And in Chrome it streams the audio to Google's
// servers, which is a third party receiving your operators' voice notes
// without ever appearing in a privacy policy or a sub-processor list. That is
// the kind of dependency that is invisible until it is a compliance problem.

const TRANSCRIBE_URL = process.env.TRANSCRIBE_URL || '';
const TRANSCRIBE_KEY = process.env.TRANSCRIBE_API_KEY || '';

/** Which wire dialect the endpoint speaks.
 *
 *  Nearly everything converged on the OpenAI shape, but ElevenLabs did not: it
 *  authenticates with an `xi-api-key` header instead of a bearer token, calls
 *  the model field `model_id` instead of `model`, and rejects the extra fields
 *  OpenAI accepts. Pointing TRANSCRIBE_URL at it without adapting produces a
 *  401 or a 422 — which reads as "voice is broken" rather than "wrong dialect".
 *
 *  Auto-detected from the host so the common case needs no configuration, with
 *  TRANSCRIBE_PROVIDER as the override for a proxy or a self-hosted gateway
 *  that speaks one dialect from an unexpected address. */
export type TranscribeProvider = 'openai' | 'elevenlabs';

export function providerFor(url: string, override?: string): TranscribeProvider {
  const forced = (override || process.env.TRANSCRIBE_PROVIDER || '').toLowerCase();
  if (forced === 'elevenlabs' || forced === 'openai') return forced;
  try {
    return new URL(url).host.endsWith('elevenlabs.io') ? 'elevenlabs' : 'openai';
  } catch {
    return 'openai';
  }
}

/** Each provider's defaults, kept together so a third one is a new entry rather
 *  than a new conditional in the request builder. */
const PROVIDERS: Record<TranscribeProvider, {
  defaultModel: string;
  modelField: string;
  authHeader: (key: string) => Record<string, string>;
}> = {
  openai: {
    defaultModel: 'whisper-1',
    modelField: 'model',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  elevenlabs: {
    // Scribe is their STT model; the TTS model ids are a different family and
    // naming one here fails in a confusing way.
    defaultModel: 'scribe_v1',
    modelField: 'model_id',
    authHeader: (key) => ({ 'xi-api-key': key }),
  },
};

/** Long enough for a real brain-dump, bounded so a stuck request cannot hold a
 *  serverless invocation open until it is killed without explanation. */
const TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS) || 120_000;

/** Roughly ten minutes of speech at a sane bitrate. A cap belongs here rather
 *  than only in the browser: the browser's limit is a suggestion to anyone
 *  posting directly. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function transcribeConfigured(): boolean {
  return Boolean(TRANSCRIBE_URL);
}

export interface Transcription {
  text: string;
  /** Seconds of audio, when the engine reports it. Not all do. */
  duration?: number;
  model: string;
}

/**
 * Turn recorded audio into text.
 *
 * Throws with a message meant for the person who just spoke, because that is
 * who sees it. "Transcription is not set up on this deployment" is actionable;
 * "fetch failed" is not, and a failed voice note is uniquely frustrating —
 * whatever they said is gone, and they have to say it again.
 */
export async function transcribeAudio(input: {
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
   *  "so ask", or "Zoe asked". */
  prompt?: string;
}): Promise<Transcription> {
  if (!transcribeConfigured()) {
    throw new Error(
      'Voice input is not set up on this deployment. Set TRANSCRIBE_URL to a speech-to-text endpoint (any Whisper-compatible server) and redeploy.',
    );
  }
  if (!input.bytes?.length) throw new Error('The recording was empty — nothing was captured.');
  if (input.bytes.length > MAX_AUDIO_BYTES) {
    throw new Error('That recording is too long. Keep voice notes under about ten minutes.');
  }

  const provider = providerFor(TRANSCRIBE_URL);
  const spec = PROVIDERS[provider];
  const model = process.env.TRANSCRIBE_MODEL || spec.defaultModel;

  const form = new FormData();
  const blob = new Blob([new Uint8Array(input.bytes)], { type: input.mimeType || 'audio/webm' });
  // The extension is load-bearing: several engines pick their decoder from the
  // filename rather than the content type, and a mismatched one fails with an
  // opaque decode error rather than an obvious rejection.
  form.append('file', blob, input.filename || 'audio.webm');
  form.append(spec.modelField, model);

  if (provider === 'elevenlabs') {
    // Deliberately NOT sending prompt/response_format: ElevenLabs rejects
    // unknown multipart fields, so passing OpenAI's extras turns a working
    // request into a 422. Language is the one shared option, under its own name.
    if (input.language) form.append('language_code', input.language);
  } else {
    if (input.language) form.append('language', input.language);
    if (input.prompt) form.append('prompt', input.prompt.slice(0, 800));
    form.append('response_format', 'json');
  }

  const controller = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(TRANSCRIBE_URL, {
      method: 'POST',
      headers: TRANSCRIBE_KEY ? spec.authHeader(TRANSCRIBE_KEY) : {},
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
    model,
  };
}

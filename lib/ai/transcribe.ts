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
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';

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

  const form = new FormData();
  const blob = new Blob([new Uint8Array(input.bytes)], { type: input.mimeType || 'audio/webm' });
  // The extension is load-bearing: several engines pick their decoder from the
  // filename rather than the content type, and a mismatched one fails with an
  // opaque decode error rather than an obvious rejection.
  form.append('file', blob, input.filename || 'audio.webm');
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
  };
}

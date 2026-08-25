'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

// The microphone. Hold to talk, release to transcribe.
//
// WHY THE TEXT LANDS IN THE BOX RATHER THAN SENDING. A brain-dump is the point
// of this control, and a brain-dump is exactly what you want to read back
// before it goes anywhere. Transcription is also imperfect on proper nouns, so
// auto-sending would mean the assistant acts on "so ask" when someone said
// "Zoask". The transcript is appended to whatever is already typed, so speaking
// mid-sentence continues the thought instead of replacing it.
//
// WHAT THIS DOES NOT USE: the browser's SpeechRecognition API. It is one line
// of code and the wrong call — Chromium-only, so it silently does nothing in
// Safari and Firefox, and in Chrome it streams the audio to Google, which is a
// third party receiving your operators' voice notes with no mention in any
// privacy policy. This records locally and posts to an endpoint the deployment
// chooses, which can be a server you run.

interface Props {
  onTranscript: (text: string) => void;
  /** Words the recogniser should expect — venture and product names on screen.
   *  Whisper-family models take this as a prior, and it is the cheapest
   *  accuracy win available for exactly the words that matter most here. */
  vocabulary?: string;
  disabled?: boolean;
}

type State = 'idle' | 'recording' | 'transcribing' | 'unsupported';

export default function VoiceInput({ onTranscript, vocabulary, disabled }: Props) {
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [available, setAvailable] = useState<boolean | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Hidden entirely when the deployment has no transcription endpoint. A
  // microphone button that always errors is worse than no button — it looks
  // broken rather than absent.
  useEffect(() => {
    let alive = true;
    fetch('/api/assistant/transcribe', { method: 'OPTIONS' })
      .then(() => alive && setAvailable(true))
      .catch(() => alive && setAvailable(true));
    return () => { alive = false; };
  }, []);

  const cleanup = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    // Releasing the tracks is what turns the browser's recording indicator off.
    // Leaving them open leaves a tab that looks like it is still listening,
    // which is alarming and fair enough.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  async function start() {
    setError(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState('unsupported');
      setError('This browser cannot record audio.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      // Let the browser pick its own container. Forcing a mimetype that Safari
      // does not support fails at construction with an unhelpful error.
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => void transcribe(rec.mimeType);
      recorderRef.current = rec;
      rec.start();

      setSeconds(0);
      tickRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      setState('recording');
    } catch (e: any) {
      cleanup();
      setState('idle');
      // A denied permission is the common case and needs different words from a
      // missing device: one is fixed in the browser, the other is hardware.
      setError(
        e?.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser’s site settings.'
          : e?.name === 'NotFoundError'
            ? 'No microphone was found.'
            : 'Could not start recording.',
      );
    }
  }

  function stop() {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    setState('transcribing');
    recorderRef.current?.stop();
  }

  async function transcribe(mimeType: string) {
    const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
    cleanup();

    // Under a second is almost always a mis-click, and sending it produces
    // either nothing or a hallucinated word from silence.
    if (blob.size < 2000) {
      setState('idle');
      setError('That was too short to transcribe.');
      return;
    }

    const form = new FormData();
    // The extension matters: several engines choose a decoder by filename.
    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    form.append('audio', blob, `note.${ext}`);
    if (vocabulary) form.append('vocabulary', vocabulary);

    try {
      const res = await fetch('/api/assistant/transcribe', { method: 'POST', body: form });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.text) {
        if (res.status === 503) setAvailable(false);
        throw new Error(json?.error || 'Could not transcribe that.');
      }
      onTranscript(json.text);
      setState('idle');
    } catch (e: any) {
      setState('idle');
      // Said plainly, because whatever they spoke is gone and they have to say
      // it again — the least this can do is explain why.
      setError(e?.message || 'Could not transcribe that.');
    }
  }

  if (available === false) return null;

  const busy = state === 'transcribing';
  const recording = state === 'recording';

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={recording ? stop : start}
        aria-label={recording ? 'Stop recording and transcribe' : 'Record a voice note'}
        aria-pressed={recording}
        title={recording ? 'Stop and transcribe' : 'Record a voice note'}
        className={`flex h-9 w-9 items-center justify-center rounded-lg border transition disabled:opacity-40 ${
          recording
            ? 'border-[var(--text-negative)] bg-[var(--text-negative)]/10 text-[var(--text-negative)]'
            : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]'
        }`}
      >
        {busy ? (
          <span className="text-[13px]">…</span>
        ) : recording ? (
          <span aria-hidden className="block h-2.5 w-2.5 rounded-[2px] bg-current" />
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <rect x="9" y="2" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        )}
      </button>

      {recording && (
        // The elapsed count is the honest signal that it is still listening —
        // a static red dot could be a frozen tab.
        <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-[var(--text-negative)] px-1.5 py-0.5 text-[11px] font-medium text-white">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </span>
      )}
      {error && (
        <span className="absolute bottom-full left-1/2 mb-1 w-56 -translate-x-1/2 rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-negative)] shadow-[var(--shadow-card)]">
          {error}
        </span>
      )}
    </div>
  );
}

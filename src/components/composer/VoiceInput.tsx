'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { METER_BARS, rmsFromTimeDomain, levelFromRms, isAudible, pushLevel } from '@/lib/audio/level';

// Live dictation for the composer: text appears WHILE you speak.
//
// HOW IT STREAMS AGAINST A NON-STREAMING ENDPOINT. Whisper-shaped servers take
// one audio file and return one transcript; there is no socket. So the
// recorder runs with a timeslice and, every few seconds, the audio SO FAR is
// posted and the interim text replaces what is in the box.
//
// Cumulative, not incremental, and that is a hard requirement rather than a
// preference: in WebM only the first chunk carries the container header, so a
// later fragment on its own is undecodable. Re-sending from the start is also
// simply more accurate — later context lets the model correct words it got
// wrong earlier, which is why the text visibly improves as you keep talking.
//
// The cost is real and worth stating: a sixty-second note is roughly fifteen
// requests with a growing payload, not one. INTERIM_MS is the dial. The final
// pass on Done is the authoritative one and always replaces the interim text.
//
// WHAT THE FIRST VERSION GOT WRONG. It was a 9x9 button and a tiny timer badge.
// Three things were missing, and each one costs a whole recording:
//
//   NO LEVEL METER. A muted microphone, the wrong input device, or a browser
//   that granted permission to a dead track all look EXACTLY like a working
//   one. You speak for a minute, press stop, and only then learn nothing was
//   captured. A live level is the only honest confirmation that the thing is
//   actually hearing you, and it costs one AnalyserNode.
//
//   NO CANCEL. Stop was the only exit and it transcribed unconditionally. So a
//   mis-click, a false start, or "actually let me say that differently" all had
//   to be sent, waited for, and then deleted by hand. Discarding is the more
//   common intent than people expect, and it should be one button.
//
//   NO PRESENCE. Recording occupied a fingernail of the screen while being the
//   only thing happening. While dictating, the bar takes over the composer row:
//   it is unambiguous what state you are in, and where the words will land.
//
// The flow is deliberately three states and no more — idle, listening,
// transcribing — because a control that can only be in states you can name is a
// control that cannot get stuck somewhere you cannot describe.

interface Props {
  /** Called repeatedly while speaking, with the best transcript so far. Always
   *  REPLACES the dictated span rather than appending, because a later pass can
   *  legitimately revise an earlier word. */
  onInterim: (text: string) => void;
  /** The authoritative transcript, once recording stops. */
  onFinal: (text: string) => void;
  /** Words the recogniser should expect — product and venture names on screen.
   *  Whisper-family models take this as a prior, and it is the cheapest
   *  accuracy win available for exactly the words that matter most here. */
  vocabulary?: string;
  disabled?: boolean;
  /** Lets the composer stand aside while dictation owns the row. */
  onActiveChange?: (active: boolean) => void;
}

type State = 'idle' | 'listening' | 'transcribing';

export default function VoiceInput({ onInterim, onFinal, vocabulary, disabled, onActiveChange }: Props) {
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);
  /** Separate from `error` on purpose. "Not set up yet" is a fact about the
   *  deployment, not a failure — rendering it in red, over the conversation,
   *  says something is broken when nothing is. */
  const [hint, setHint] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => new Array(METER_BARS).fill(0));
  const [available, setAvailable] = useState<boolean | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  /** Set before stopping when the user is throwing the recording away, so the
   *  recorder's own stop handler knows not to send anything. */
  const cancelledRef = useRef(false);
  /** True while any audio has actually been detected. Used to tell "you said
   *  nothing" apart from "your microphone is not working", which need
   *  completely different remedies. */
  const heardRef = useRef(false);
  /** Guards against interim passes piling up: if one is still in flight when
   *  the next tick fires, that tick is skipped. Without this a slow engine
   *  produces overlapping requests that can also land out of order, so the box
   *  would flicker backwards to an older transcript. */
  const inFlightRef = useRef(false);
  const interimTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** How often to refresh the interim transcript. Short enough to feel live,
   *  long enough that each pass has a sentence to work with — under about two
   *  seconds the model is guessing at fragments and the text churns. */
  const INTERIM_MS = 3500;

  useEffect(() => { onActiveChange?.(state !== 'idle'); }, [state, onActiveChange]);

  // Ask the SERVER whether voice input is configured — TRANSCRIBE_URL is
  // server-side only, so the browser cannot know, and a microphone that always
  // fails is worse than no microphone.
  useEffect(() => {
    let alive = true;
    fetch('/api/assistant/transcribe', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setAvailable(Boolean(d?.configured)); })
      .catch(() => { if (alive) setAvailable(false); });
    return () => { alive = false; };
  }, []);

  const cleanup = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    if (interimTimerRef.current) { clearInterval(interimTimerRef.current); interimTimerRef.current = null; }
    inFlightRef.current = false;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    // Releasing the tracks is what turns the browser's recording indicator off.
    // Leaving them open leaves a tab that looks like it is still listening.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setLevels(new Array(METER_BARS).fill(0));
  }, []);

  useEffect(() => cleanup, [cleanup]);

  /** Drive the level meter off the live stream. */
  function meter(stream: MediaStream) {
    try {
      const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);

      const draw = () => {
        analyser.getByteTimeDomainData(buf);
        // RMS around the 128 midpoint — amplitude, not frequency, because what
        // is being answered is "is sound arriving", not "what does it sound
        // like".
        const rms = rmsFromTimeDomain(buf);
        if (isAudible(rms)) heardRef.current = true;
        const level = levelFromRms(rms);
        setLevels((prev) => pushLevel(prev, level));
        rafRef.current = requestAnimationFrame(draw);
      };
      rafRef.current = requestAnimationFrame(draw);
    } catch {
      // A missing AudioContext costs the meter, not the recording.
    }
  }

  async function start() {
    setError(null);
    cancelledRef.current = false;
    heardRef.current = false;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot record audio.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Ask for the processing every dictation UI relies on. Browsers ignore
        // what they do not support, so this is free where it is unavailable.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      chunksRef.current = [];

      // Let the browser choose its container. Forcing a mimetype Safari does
      // not support fails at construction with an unhelpful error.
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const mime = rec.mimeType;
        if (cancelledRef.current) { cleanup(); setState('idle'); return; }
        void transcribe(mime);
      };
      recorderRef.current = rec;
      // A timeslice is what makes chunks arrive DURING the recording rather
      // than all at once at the end — without it there is nothing to send.
      rec.start(1000);
      meter(stream);
      interimTimerRef.current = setInterval(() => void refreshInterim(rec.mimeType), INTERIM_MS);

      setSeconds(0);
      tickRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      setState('listening');
    } catch (e: any) {
      cleanup();
      setState('idle');
      // A denied permission and a missing device need different words: one is
      // fixed in the browser, the other is hardware.
      setError(
        e?.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser’s site settings, then try again.'
          : e?.name === 'NotFoundError'
            ? 'No microphone was found.'
            : 'Could not start recording.',
      );
    }
  }

  /** Throw the recording away. Nothing is uploaded and nothing is transcribed. */
  function cancel() {
    cancelledRef.current = true;
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    try { recorderRef.current?.stop(); } catch { /* already stopped */ }
    cleanup();
    setState('idle');
    setError(null);
    // Take back whatever the interim passes had written. Cancel means discard,
    // and leaving half a transcript behind would be the opposite.
    onInterim('');
  }

  /** Finish and send it up for transcription. */
  function done() {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    setState('transcribing');
    try { recorderRef.current?.stop(); } catch { setState('idle'); }
  }

  /** Post the audio recorded SO FAR and return its transcript.
   *  Shared by the interim passes and the final one, so they cannot drift. */
  async function postAudio(blob: Blob, mimeType: string): Promise<string> {
    const form = new FormData();
    // The extension is load-bearing: several engines pick a decoder by filename.
    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    form.append('audio', blob, `note.${ext}`);
    if (vocabulary) form.append('vocabulary', vocabulary);
    const res = await fetch('/api/assistant/transcribe', { method: 'POST', body: form });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.text) {
      throw new Error(
        res.status === 503
          ? 'Voice input is not set up on this deployment yet (TRANSCRIBE_URL is not configured).'
          : json?.error || 'Could not transcribe that.',
      );
    }
    return String(json.text);
  }

  /** One interim pass. Deliberately silent on failure: a dropped refresh is not
   *  worth an error banner mid-sentence, the next tick will try again, and the
   *  final pass is what actually counts. */
  async function refreshInterim(mimeType: string) {
    if (inFlightRef.current || cancelledRef.current) return;
    const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
    if (blob.size < 2000) return;
    inFlightRef.current = true;
    try {
      const text = await postAudio(blob, mimeType);
      // Discard a response that arrived after the user cancelled or finished —
      // otherwise a slow request repopulates a box they already cleared.
      if (!cancelledRef.current && recorderRef.current) onInterim(text);
    } catch {
      /* see above */
    } finally {
      inFlightRef.current = false;
    }
  }

  async function transcribe(mimeType: string) {
    const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
    const heard = heardRef.current;
    cleanup();

    if (blob.size < 2000) {
      setState('idle');
      // The meter already answered this question, so the message can be
      // specific rather than a shrug.
      setError(heard ? 'That was too short to transcribe.' : 'Nothing was picked up — check the microphone is not muted.');
      return;
    }

    try {
      // Authoritative: the full recording, with every word in context. Always
      // replaces whatever the interim passes left behind.
      const text = await postAudio(blob, mimeType);
      onFinal(text);
      setState('idle');
      // Put the cursor where the words went. Text appearing in a box nobody is
      // looking at reads as nothing having happened.
      const box = document.querySelector<HTMLTextAreaElement>('textarea[data-composer]');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    } catch (e: any) {
      // Deliberately does NOT hide the control. An earlier version set
      // available=false here, which unmounted the component on the next render
      // and took its own error message with it — press record, watch the button
      // vanish, learn nothing.
      setState('idle');
      setError(e?.message || 'Could not transcribe that.');
    }
  }

  // NOT hidden when unconfigured — that was the wrong call, twice over.
  //
  // Hiding it makes "this product has no dictation" and "dictation needs one
  // environment variable" look identical, and the person most likely to be
  // looking at this console is the person who sets that variable. A missing
  // control cannot explain itself; a disabled one can. So it stays, greyed,
  // and says what it needs when pressed.
  const unconfigured = available === false;

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  // --- listening / transcribing: the bar owns the row --------------------
  if (state !== 'idle') {
    const listening = state === 'listening';
    return (
      <div
        className="flex shrink-0 items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] px-2.5 py-2"
        role="status"
        aria-live="polite"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${listening ? 'animate-pulse bg-[var(--text-negative)]' : 'bg-[var(--text-muted)]'}`} aria-hidden />
        <span className="shrink-0 text-[13px] font-medium tabular-nums text-[var(--text-primary)]">{mmss}</span>

        {/* The live level. This is the part that tells you the microphone is
            actually hearing you — without it, a muted input is indistinguishable
            from a working one until after you have spoken. */}
        {/* Fixed width: the composer beside this is where the words are
            appearing, and it must not be squeezed as the meter animates. */}
        <div className="flex h-6 w-[72px] shrink-0 items-center gap-[3px]" aria-hidden>
          {levels.map((v, i) => (
            <span
              key={i}
              className={`w-full rounded-full transition-[height] duration-75 ${listening ? 'bg-[var(--brand)]' : 'bg-[var(--border-strong)]'}`}
              style={{ height: `${Math.max(3, v * 24)}px` }}
            />
          ))}
        </div>

        {listening ? (
          <>
            <button
              type="button" onClick={cancel} aria-label="Discard this recording" title="Discard"
              className="shrink-0 rounded-md px-1.5 py-1 text-[12px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
            <button
              type="button" onClick={done} aria-label="Stop recording and transcribe" title="Done"
              className="shrink-0 rounded-md bg-[var(--ink)] px-2.5 py-1 text-[12px] font-medium text-[var(--ink-fg)] transition hover:bg-[var(--ink-hover)]"
            >
              Done
            </button>
          </>
        ) : (
          <span className="shrink-0 text-[12px] text-[var(--text-muted)]">Transcribing…</span>
        )}
      </div>
    );
  }

  // --- idle: just the button --------------------------------------------
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={unconfigured ? () => setHint((h) => !h) : start}
        aria-label={unconfigured ? 'Dictation is not available on this workspace yet' : 'Dictate a message'}
        // Said in the user's terms, not the deployment's. TRANSCRIBE_URL is
        // developer language and the people using this console will never set
        // it — that detail belongs where the person who CAN act on it looks.
        title={unconfigured ? 'Dictation is not available on this workspace yet' : 'Dictate a message'}
        className={`flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-default)] transition disabled:opacity-40 ${
          unconfigured
            ? 'cursor-help text-[var(--text-muted)] opacity-60 hover:opacity-100'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]'
        }`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <rect x="9" y="2" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      </button>

      {hint && unconfigured && (
        // Muted, narrow, and dismissible. Not red: nothing has gone wrong.
        <button
          type="button"
          onClick={() => setHint(false)}
          className="absolute bottom-full right-0 z-20 mb-1.5 w-52 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-2.5 py-2 text-left text-[11px] leading-snug text-[var(--text-secondary)] shadow-[var(--shadow-card)]"
        >
          Dictation is not available on this workspace yet.
        </button>
      )}

      {error && (
        // role="alert" so it is announced, dismissible so it cannot sit there
        // forever, z-20 because the composer row clips — an error rendered
        // underneath the layout is the same as no error at all.
        <button
          type="button"
          role="alert"
          onClick={() => setError(null)}
          title="Dismiss"
          className="absolute bottom-full right-0 z-20 mb-1.5 w-64 rounded-lg border border-[var(--text-negative)]/30 bg-[var(--bg-surface)] px-2.5 py-2 text-left text-[11px] leading-snug text-[var(--text-negative)] shadow-[var(--shadow-pop)]"
        >
          {error}
        </button>
      )}
    </div>
  );
}

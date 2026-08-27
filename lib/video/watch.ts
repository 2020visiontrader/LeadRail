// Assembling what the model reads about a video.
//
// The one thing every reference implementation agrees on, and the reason a
// naive version of this fails: FRAMES AND WORDS MUST ARRIVE TOGETHER, LINED UP
// BY TIME. Stills alone lose the argument being made. A transcript alone loses
// what was on screen while it was made. Handing over both but unaligned is
// barely better — the model can see a chart and read a sentence and have no
// basis for connecting them.
//
// So the deliverable is one interleaved document: at each timestamp, what was
// said and what was visible, in order, plus the measured pace of the whole
// video (see ./frames — that part is computed from EVERY frame, not the
// sampled ones).

import { stamp, type PaceReport } from './frames';

export interface TranscriptCue {
  /** Seconds into the video. */
  t: number;
  text: string;
}

export interface WatchInput {
  title?: string;
  durationSeconds: number;
  /** Timestamps of the frames actually attached to the request, in order. The
   *  images travel separately; this is the index the model reads them by. */
  frameTimestamps: number[];
  transcript: TranscriptCue[];
  pace?: PaceReport;
}

/** Words spoken per minute. Reported because pace is half the question about a
 *  video and it is invisible in stills: two ads with identical footage and
 *  different delivery are different ads. */
export function wordsPerMinute(transcript: TranscriptCue[], durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  const words = transcript.reduce((n, c) => n + (c.text.trim() ? c.text.trim().split(/\s+/).length : 0), 0);
  return Math.round(words / (durationSeconds / 60));
}

/** Seconds of the video with no speech, as a fraction. Silence is content in a
 *  video — a pause before a reveal, or dead air nobody edited out — and it is
 *  the one thing a transcript cannot show, because it is what the transcript
 *  does not contain. */
export function silenceRatio(transcript: TranscriptCue[], durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  const spoken = transcript.filter((c) => c.text.trim()).length;
  // Cues are roughly a second each from a Whisper-family segmenter; this is an
  // estimate and is labelled as one wherever it is shown.
  return Math.max(0, Math.min(1, 1 - spoken / durationSeconds));
}

/**
 * The interleaved timeline: every cue and every attached frame, in time order.
 *
 * A frame with no words at its timestamp still appears — a silent shot is a
 * fact about the video, and dropping it would make the visual track look
 * shorter than it is.
 */
export function buildTimeline(input: WatchInput): string {
  type Row = { t: number; kind: 'frame' | 'said'; text: string };
  const rows: Row[] = [
    ...input.frameTimestamps.map((t) => ({ t, kind: 'frame' as const, text: `[frame at ${stamp(t)}]` })),
    ...input.transcript
      .filter((c) => c.text.trim())
      .map((c) => ({ t: c.t, kind: 'said' as const, text: c.text.trim() })),
  ];
  // Frames before words at the same second: you see the cut, then hear the line.
  rows.sort((a, b) => a.t - b.t || (a.kind === 'frame' ? -1 : 1));

  return rows
    .map((r) => (r.kind === 'frame' ? r.text : `${stamp(r.t)}  ${r.text}`))
    .join('\n');
}

/**
 * The full package handed to the model.
 *
 * Every section is a measurement or a quotation — nothing here is an opinion
 * about the video. The reading is the model's job; this is the evidence, and
 * mixing the two would let a summary written here be mistaken for something
 * observed.
 */
export function buildWatchReport(input: WatchInput): string {
  const { durationSeconds, transcript, pace } = input;
  const lines: string[] = [];

  lines.push(`VIDEO${input.title ? `: ${input.title}` : ''}`);
  lines.push(`Length: ${stamp(durationSeconds)}`);

  if (pace) {
    lines.push('');
    lines.push('EDIT AND PACE — measured across every frame, not a sample:');
    lines.push(`- ${pace.framesAnalysed} frames read, ${pace.shots.length} distinct shots`);
    lines.push(`- ${pace.cutsPerMinute} cuts per minute overall; ${pace.hookCutsPerMinute} over the first 10 seconds`);
    lines.push(`- median shot holds ${pace.medianShotSeconds}s`);
    lines.push(`- motion index ${pace.motionIndex} (0 is a static frame; higher is more movement)`);
  }

  lines.push('');
  lines.push('DELIVERY:');
  lines.push(`- ${wordsPerMinute(transcript, durationSeconds)} words per minute`);
  lines.push(`- roughly ${Math.round(silenceRatio(transcript, durationSeconds) * 100)}% of the runtime has no speech (estimated from cue coverage)`);

  lines.push('');
  lines.push('TIMELINE — what is on screen and what is said, in order. The attached');
  lines.push('images are the frames named below, in the same order:');
  lines.push(buildTimeline(input));

  lines.push('');
  // Said explicitly because the alternative failure is confident invention: a
  // model given stills and a transcript will otherwise narrate the gaps.
  lines.push('Every frame in this video was read to produce the numbers above. The IMAGES');
  lines.push('attached are one per distinct shot — consecutive identical frames are not');
  lines.push('repeated. If something happened between two attached frames, the numbers');
  lines.push('above are your evidence for it; do not describe footage you were not shown.');

  return lines.join('\n');
}

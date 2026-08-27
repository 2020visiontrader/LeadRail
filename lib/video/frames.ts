// Choosing which frames of a video the model actually sees.
//
// A video is mostly redundant. Thirty seconds of a talking head is one frame
// repeated 900 times, and sending all of it is both unaffordable and worse than
// sending ten well-chosen stills — the signal is buried in the repetition.
//
// Two decisions do almost all the work here, and both come from the same place:
// what KIND of footage is this.
//
//   Cadence. A screen recording changes what matters every few seconds — a new
//   panel, a new field, a click landing. A talking head does not; the face is
//   the same at 0:05 and 0:35 and the words carry the content. Sampling both at
//   one rate either floods the context with duplicates or misses every UI state.
//
//   Deduplication. Even at the right cadence, consecutive frames repeat. Cheap
//   perceptual comparison — downscale hard, compare, drop the near-identical —
//   removes most of that without needing scene detection.
//
// This module is the ARITHMETIC only. Decoding frames belongs to whatever has
// the video (the browser, ffmpeg); it is untestable and platform-specific, and
// keeping it out means the part that decides what gets seen can be tested.

/** What kind of footage this is. The cadences below are the whole reason this
 *  distinction is asked for rather than inferred. */
export type VideoKind = 'screen' | 'talking-head' | 'ad' | 'general';

/** Seconds between sampled frames, per kind.
 *
 *  `ad` is the tight one on purpose: a paid ad's entire job happens in its
 *  first seconds, and a cadence that samples a 15-second spot four times has
 *  not looked at the thing being asked about. */
export const CADENCE_SECONDS: Record<VideoKind, number> = {
  screen: 5,
  'talking-head': 30,
  ad: 2,
  general: 15,
};

/** Hard cap on frames handed to one analysis. Each frame is an image in the
 *  context window, so this is a budget, not a preference. */
export const MAX_FRAMES = Number(process.env.VIDEO_MAX_FRAMES) || 60;

/** Extra density over the opening seconds.
 *
 *  For an ad or a social post the hook is the question — "why does this work"
 *  is almost always answered in the first few seconds — so those get sampled at
 *  every second regardless of the kind's ordinary cadence. */
export const HOOK_WINDOW_SECONDS = 10;

/**
 * Timestamps to sample, in seconds.
 *
 * Dense over the hook window, then at the kind's cadence, capped. When the cap
 * bites, frames are dropped by THINNING the later ones evenly rather than
 * truncating: a 40-minute video sampled to its first 60 frames has watched the
 * first ten minutes, which is not what anyone asked for.
 */
export function sampleTimestamps(
  durationSeconds: number,
  kind: VideoKind = 'general',
  opts?: { maxFrames?: number; hookWindow?: number },
): number[] {
  const max = Math.max(1, opts?.maxFrames ?? MAX_FRAMES);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [0];

  const hookWindow = Math.min(opts?.hookWindow ?? HOOK_WINDOW_SECONDS, durationSeconds);
  const cadence = CADENCE_SECONDS[kind];

  const hook: number[] = [];
  for (let t = 0; t < hookWindow; t += 1) hook.push(t);

  const body: number[] = [];
  for (let t = Math.ceil(hookWindow); t < durationSeconds; t += cadence) body.push(t);

  if (hook.length >= max) return thin(hook, max);
  return [...hook, ...thin(body, max - hook.length)];
}

/** Keep `keep` items spread evenly across the list, always including the first
 *  and last. Evenly, not the first N — see the note in sampleTimestamps. */
export function thin(items: number[], keep: number): number[] {
  if (keep <= 0) return [];
  if (items.length <= keep) return items;
  if (keep === 1) return [items[0]];
  const step = (items.length - 1) / (keep - 1);
  const out: number[] = [];
  for (let i = 0; i < keep; i++) out.push(items[Math.round(i * step)]);
  return [...new Set(out)];
}

/** Side of the square thumbnail frames are reduced to before comparison.
 *  Small enough that compression noise and a moving mouth do not register,
 *  large enough that a slide change does. */
export const THUMB_SIDE = 16;

/** Mean absolute difference, 0-255, below which two frames are "the same
 *  shot". Tuned to the same intent as the reference implementations: it should
 *  drop a repeated talking-head frame and keep a cut. */
export const DUPLICATE_MAD = 2.0;

/**
 * Mean absolute difference between two grayscale thumbnails.
 *
 * Throws on a length mismatch rather than comparing what it can: two thumbnails
 * of different sizes is a bug in the caller, and silently returning a large
 * number would present it as "these frames differ" — the failure would look
 * like working deduplication.
 */
export function meanAbsDiff(a: Uint8Array | number[], b: Uint8Array | number[]): number {
  if (a.length !== b.length) throw new Error('Thumbnails must be the same size to compare.');
  if (!a.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

export interface FrameThumb {
  /** Seconds into the video. */
  t: number;
  /** Grayscale thumbnail, THUMB_SIDE * THUMB_SIDE bytes. */
  thumb: Uint8Array | number[];
}

/**
 * Drop frames that are near-identical to the one KEPT before them.
 *
 * Compared against the last kept frame rather than the immediately preceding
 * one, so a slow pan does not creep past the threshold one imperceptible step
 * at a time and survive in full.
 *
 * The first frame is always kept: something has to establish the baseline, and
 * on a short clip it is often the only frame that matters.
 */
export function dedupe(frames: FrameThumb[], threshold: number = DUPLICATE_MAD): FrameThumb[] {
  if (frames.length <= 1) return frames;
  const kept: FrameThumb[] = [frames[0]];
  for (let i = 1; i < frames.length; i++) {
    if (meanAbsDiff(frames[i].thumb, kept[kept.length - 1].thumb) > threshold) kept.push(frames[i]);
  }
  return kept;
}

/** `M:SS` / `H:MM:SS` — how a timestamp is labelled on a frame and in the
 *  transcript, so the model can line the two up. */
export function stamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// FULL-FRAME PASS
// ---------------------------------------------------------------------------
// "Analyse every frame" and "send every frame to the model" are different
// requests, and only one of them is possible. A 60-second clip at 30fps is
// 1,800 images; at roughly 500 tokens each that is 900k tokens for one minute
// of video, past every model's window — and 1,790 of those frames are the
// previous frame again. Sending them would cost enormously to say nothing.
//
// So every frame IS read, here, in arithmetic. What comes out is not a pile of
// images but MEASUREMENTS no sample could give you: where the cuts are, how
// long each shot holds, how fast the edit moves, where motion spikes. Those are
// facts about the whole video, computed from all of it.
//
// The model then receives the complete package: one still per shot (so it has
// seen every distinct thing on screen), the full transcript (so it has every
// word), and this measured timeline (so it knows the pace it cannot see in
// stills). Nothing is skipped. What is deduplicated is the image payload, and
// only where the images are literally the same picture.

/** A cut is a frame that differs sharply from the one before it. Well above
 *  DUPLICATE_MAD, which asks a much weaker question ("is this the same
 *  picture?"); this one asks "did the shot change?" and a threshold near the
 *  dedupe value would call every camera wobble a cut. */
export const CUT_MAD = 18.0;

export interface Shot {
  /** Seconds into the video where this shot begins. */
  start: number;
  /** Seconds where it ends — the next cut, or the end of the video. */
  end: number;
  /** Length in seconds. The number that carries pace. */
  duration: number;
  /** Timestamp of the frame that best represents this shot: its first, which is
   *  what a viewer actually sees at the cut. */
  keyframe: number;
}

export interface PaceReport {
  durationSeconds: number;
  framesAnalysed: number;
  shots: Shot[];
  /** Cuts per minute over the whole video — the single number that says
   *  "fast edit" or "slow edit" without watching it. */
  cutsPerMinute: number;
  /** Median shot length. Median rather than mean: one long outro shot drags a
   *  mean far away from what the video feels like. */
  medianShotSeconds: number;
  /** Cuts per minute over the opening window only. Reported separately because
   *  a fast hook on a slow video and a uniformly fast video are different
   *  edits, and the blended average hides which one this is. */
  hookCutsPerMinute: number;
  /** Mean frame-to-frame difference — how much the picture moves overall.
   *  Distinguishes a static screen recording from handheld footage. */
  motionIndex: number;
}

/**
 * Read every frame; return the shot structure and pace of the whole video.
 *
 * `frames` must be EVERY decoded frame in order, each with its timestamp and
 * grayscale thumbnail. Passing a sample produces a confident, wrong answer —
 * cuts between sampled frames simply do not exist as far as this can tell, so
 * a 12-cut video sampled every 5 seconds reports a slow edit.
 */
export function analyseAllFrames(frames: FrameThumb[], durationSeconds: number): PaceReport {
  const empty: PaceReport = {
    durationSeconds, framesAnalysed: frames.length, shots: [], cutsPerMinute: 0,
    medianShotSeconds: 0, hookCutsPerMinute: 0, motionIndex: 0,
  };
  if (!frames.length) return empty;

  const cuts: number[] = [frames[0].t];
  let diffTotal = 0;
  for (let i = 1; i < frames.length; i++) {
    const d = meanAbsDiff(frames[i].thumb, frames[i - 1].thumb);
    diffTotal += d;
    if (d > CUT_MAD) cuts.push(frames[i].t);
  }

  const shots: Shot[] = cuts.map((start, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1] : durationSeconds;
    return { start, end, duration: Math.max(0, end - start), keyframe: start };
  });

  const minutes = durationSeconds / 60;
  const hookWindow = Math.min(HOOK_WINDOW_SECONDS, durationSeconds);
  const hookCuts = cuts.filter((t) => t < hookWindow).length;

  return {
    durationSeconds,
    framesAnalysed: frames.length,
    shots,
    // Cuts, not shots: a single-shot video has one shot and zero cuts, and
    // reporting 1 cut for a video nobody edited would be wrong.
    cutsPerMinute: minutes > 0 ? round2((cuts.length - 1) / minutes) : 0,
    medianShotSeconds: round2(median(shots.map((s) => s.duration))),
    hookCutsPerMinute: hookWindow > 0 ? round2((hookCuts - 1) / (hookWindow / 60)) : 0,
    motionIndex: frames.length > 1 ? round2(diffTotal / (frames.length - 1)) : 0,
  };
}

/** One keyframe per shot — every distinct thing on screen, nothing repeated.
 *  Capped, thinned evenly rather than truncated, for the reason in `thin`. */
export function keyframesForShots(report: PaceReport, max: number = MAX_FRAMES): number[] {
  return thin(report.shots.map((s) => s.keyframe), max);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

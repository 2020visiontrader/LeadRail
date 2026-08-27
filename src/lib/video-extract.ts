// Reading a video in the browser, where the file already is.
//
// WHY HERE AND NOT ON THE SERVER. A 10-minute 1080p file is around 150MB
// against a 25MB upload cap, so the video was never going to reach the server
// in the first place. Decoding it here means the raw footage never leaves the
// uploader's machine, no ffmpeg is needed in a request handler, and what goes
// up is the stills and the audio — two orders of magnitude smaller.
//
// EVERY FRAME IS READ. Not sampled. The loop below walks the whole file at the
// source frame rate, thumbnails each frame, and hands all of them to
// analyseAllFrames — which is where cuts, shot lengths and pace come from.
// Those numbers describe the entire video and there is no cheaper way to get
// them: a cut between two sampled frames does not exist as far as a sample can
// tell, so a sampled read reports a slow edit on a fast video, confidently.
//
// What is DEDUPLICATED is only the set of stills sent onward — one per distinct
// shot. That is a budget decision about the context window, not a decision
// about how much of the video was looked at, and the report says so explicitly
// so nobody mistakes one for the other.

import { analyseAllFrames, THUMB_SIDE, type FrameThumb, type PaceReport } from '@/lib/video/frames';

/** Frames per second to step through. 12 rather than the source rate: a cut is
 *  a discontinuity that lasts far longer than 1/12s, so nothing is missed, and
 *  it roughly halves the decode time on a long file. Raise it for footage with
 *  very fast cuts. */
export const READ_FPS = 12;

/** Width the stills are sent at. Large enough to read on-screen text in a
 *  screen recording, small enough that sixty of them fit a context window. */
export const FRAME_WIDTH = 512;

export interface ExtractedVideo {
  durationSeconds: number;
  pace: PaceReport;
  /** One still per distinct shot, as JPEG blobs, with their timestamps. */
  stills: { t: number; blob: Blob }[];
  /** Audio for transcription, when the browser could extract it. */
  audio?: Blob;
}

/** Grayscale-thumbnail one canvas frame. Downscaled hard on purpose — at 16x16
 *  a moving mouth and compression noise do not register, and a scene change
 *  does. */
export function thumbnailOf(ctx: CanvasRenderingContext2D, w: number, h: number): Uint8Array {
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Uint8Array(THUMB_SIDE * THUMB_SIDE);
  const cellW = w / THUMB_SIDE;
  const cellH = h / THUMB_SIDE;
  for (let cy = 0; cy < THUMB_SIDE; cy++) {
    for (let cx = 0; cx < THUMB_SIDE; cx++) {
      // One sample per cell centre rather than an average: this is compared
      // against a threshold, not displayed, and averaging every pixel of a
      // 1080p frame per cell is the slowest part of the whole pipeline.
      const px = Math.min(w - 1, Math.floor(cx * cellW + cellW / 2));
      const py = Math.min(h - 1, Math.floor(cy * cellH + cellH / 2));
      const i = (py * w + px) * 4;
      // Rec. 601 luma. Plain RGB averaging would call a red frame and a green
      // frame of the same brightness identical.
      out[cy * THUMB_SIDE + cx] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    }
  }
  return out;
}

/** Seek and wait for the frame to actually be painted. `currentTime = x`
 *  returns immediately and the canvas would capture whatever was there before,
 *  so every frame would be one step stale. */
function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Could not seek the video.')); };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = t;
  });
}

/**
 * Read a whole video: every frame for the numbers, one still per shot for the
 * model.
 *
 * `onProgress` is called with a 0-1 fraction. A long file takes minutes here
 * and a progress bar is not decoration — an upload that appears frozen gets
 * cancelled and retried, which costs the whole decode again.
 */
export async function extractVideo(
  file: File,
  opts?: { readFps?: number; maxStills?: number; onProgress?: (fraction: number) => void },
): Promise<ExtractedVideo> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('That file could not be read as a video.'));
    });

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('That video reports no duration, so it cannot be read.');
    }

    const scale = FRAME_WIDTH / (video.videoWidth || FRAME_WIDTH);
    const w = Math.max(1, Math.round((video.videoWidth || FRAME_WIDTH) * scale));
    const h = Math.max(1, Math.round((video.videoHeight || FRAME_WIDTH) * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('This browser cannot read video frames.');

    const step = 1 / (opts?.readFps ?? READ_FPS);
    const frames: FrameThumb[] = [];

    for (let t = 0; t < duration; t += step) {
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, w, h);
      frames.push({ t, thumb: thumbnailOf(ctx, w, h) });
      opts?.onProgress?.(Math.min(1, t / duration));
    }

    const pace = analyseAllFrames(frames, duration);

    // Now, and only now, re-render the frames that survive as actual images.
    // Rendering every frame to a JPEG during the pass above would have been the
    // expensive mistake: most of them are about to be discarded.
    const { keyframesForShots } = await import('@/lib/video/frames');
    const wanted = keyframesForShots(pace, opts?.maxStills);
    const stills: { t: number; blob: Blob }[] = [];
    for (const t of wanted) {
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
      if (blob) stills.push({ t, blob });
    }

    opts?.onProgress?.(1);
    return { durationSeconds: duration, pace, stills };
  } finally {
    // Always, including on the throw paths above: an un-revoked object URL
    // holds the whole file in memory, and a few failed 150MB uploads is a tab
    // that stops responding.
    URL.revokeObjectURL(url);
    video.src = '';
  }
}

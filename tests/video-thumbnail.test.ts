// The thumbnail is what every cut, shot and pace number is computed from. If it
// is wrong, the whole video read is wrong in a way that still looks plausible.
// No DOM in this project, so the canvas context is stubbed to the one method
// used.

import { describe, it, expect } from 'vitest';
import { thumbnailOf } from '@/src/lib/video-extract';
import { THUMB_SIDE, meanAbsDiff } from '@/lib/video/frames';

/** Minimal getImageData stub over a solid RGB fill. */
function solid(r: number, g: number, b: number, w = 64, h = 64) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { getImageData: () => ({ data }) } as unknown as CanvasRenderingContext2D;
}

describe('thumbnailOf', () => {
  it('produces exactly THUMB_SIDE squared samples', () => {
    expect(thumbnailOf(solid(10, 10, 10), 64, 64)).toHaveLength(THUMB_SIDE * THUMB_SIDE);
  });

  it('is stable for the same picture', () => {
    // Two reads of an unchanged frame must compare as identical, or every
    // frame reads as a cut and the pace numbers are noise.
    const a = thumbnailOf(solid(120, 120, 120), 64, 64);
    const b = thumbnailOf(solid(120, 120, 120), 64, 64);
    expect(meanAbsDiff(a, b)).toBe(0);
  });

  it('separates colours of equal RGB average', () => {
    // Plain averaging would call these identical. Rec. 601 luma does not —
    // which is the difference between seeing a cut to a different scene and
    // missing it.
    const red = thumbnailOf(solid(255, 0, 0), 64, 64);
    const green = thumbnailOf(solid(0, 255, 0), 64, 64);
    expect(meanAbsDiff(red, green)).toBeGreaterThan(20);
  });

  it('registers a brightness change as a difference', () => {
    const dark = thumbnailOf(solid(20, 20, 20), 64, 64);
    const bright = thumbnailOf(solid(220, 220, 220), 64, 64);
    expect(meanAbsDiff(dark, bright)).toBeGreaterThan(150);
  });

  it('handles a frame smaller than the thumbnail grid without reading past it', () => {
    // An 8x8 source into a 16x16 grid: every cell centre must still land inside
    // the buffer, or this reads undefined and produces NaN samples.
    const t = thumbnailOf(solid(100, 100, 100, 8, 8), 8, 8);
    expect(t.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
  });
});

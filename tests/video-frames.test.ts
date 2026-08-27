// What the model sees of a video, and what it is told about the parts it does
// not see. The interesting cases are the ones where a plausible shortcut gives
// a confident wrong answer.

import { describe, it, expect } from 'vitest';
import {
  sampleTimestamps, thin, meanAbsDiff, dedupe, stamp, analyseAllFrames,
  keyframesForShots, CADENCE_SECONDS, THUMB_SIDE, DUPLICATE_MAD, CUT_MAD,
} from '@/lib/video/frames';

const flat = (v: number) => new Uint8Array(THUMB_SIDE * THUMB_SIDE).fill(v);
const frame = (t: number, v: number) => ({ t, thumb: flat(v) });

describe('sampleTimestamps', () => {
  it('samples the opening every second whatever the cadence', () => {
    // The hook is the question on an ad or a social post; the ordinary cadence
    // would look at a 15-second spot a handful of times.
    const ts = sampleTimestamps(60, 'talking-head');
    expect(ts.slice(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('uses a tighter cadence for a screen recording than a talking head', () => {
    expect(CADENCE_SECONDS.screen).toBeLessThan(CADENCE_SECONDS['talking-head']);
    const screen = sampleTimestamps(300, 'screen');
    const head = sampleTimestamps(300, 'talking-head');
    expect(screen.length).toBeGreaterThan(head.length);
  });

  it('thins across the WHOLE video when capped, never truncates', () => {
    // Truncating a 40-minute video to its first 60 frames watches ten minutes
    // and reports on forty.
    const ts = sampleTimestamps(2400, 'general', { maxFrames: 20 });
    expect(ts.length).toBeLessThanOrEqual(20);
    expect(Math.max(...ts)).toBeGreaterThan(2000);
  });

  it('survives a zero or unknown duration', () => {
    expect(sampleTimestamps(0)).toEqual([0]);
    expect(sampleTimestamps(NaN)).toEqual([0]);
  });
});

describe('thin', () => {
  it('keeps the first and last', () => {
    const out = thin([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(9);
  });

  it('returns everything when it already fits', () => {
    expect(thin([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('handles the degenerate asks', () => {
    expect(thin([1, 2, 3], 0)).toEqual([]);
    expect(thin([1, 2, 3], 1)).toEqual([1]);
  });
});

describe('meanAbsDiff', () => {
  it('is zero for identical thumbnails', () => {
    expect(meanAbsDiff(flat(100), flat(100))).toBe(0);
  });

  it('measures the gap', () => {
    expect(meanAbsDiff(flat(100), flat(110))).toBe(10);
  });

  it('throws on a size mismatch rather than reporting a big difference', () => {
    // Returning a large number here would look exactly like working
    // deduplication while comparing nonsense.
    expect(() => meanAbsDiff(new Uint8Array(4), new Uint8Array(9))).toThrow();
  });
});

describe('dedupe', () => {
  it('drops near-identical frames', () => {
    const frames = [frame(0, 100), frame(1, 101), frame(2, 100), frame(3, 200)];
    expect(dedupe(frames).map((f) => f.t)).toEqual([0, 3]);
  });

  it('always keeps the first frame', () => {
    expect(dedupe([frame(0, 50), frame(1, 50)])).toHaveLength(1);
  });

  it('compares against the last KEPT frame, so a slow pan cannot creep past', () => {
    // Each step is 1, under the 2.0 threshold, so comparing with the immediate
    // predecessor would keep NOTHING after the first. Against the last kept
    // frame the drift accumulates and crosses at t=3.
    const frames = [frame(0, 100), frame(1, 101), frame(2, 102), frame(3, 103), frame(4, 104)];
    expect(dedupe(frames, DUPLICATE_MAD).map((f) => f.t)).toEqual([0, 3]);
  });
});

describe('analyseAllFrames', () => {
  it('finds the cuts and the shots between them', () => {
    const frames = [
      frame(0, 10), frame(1, 10), frame(2, 10),      // shot A
      frame(3, 200), frame(4, 200),                   // cut -> shot B
      frame(5, 10),                                   // cut -> shot C
    ];
    const r = analyseAllFrames(frames, 6);
    expect(r.shots.map((s) => s.start)).toEqual([0, 3, 5]);
    expect(r.framesAnalysed).toBe(6);
  });

  it('reports CUTS, not shots — an unedited video has zero', () => {
    const frames = [frame(0, 10), frame(1, 10), frame(2, 10)];
    expect(analyseAllFrames(frames, 60).cutsPerMinute).toBe(0);
  });

  it('uses a much higher threshold for a cut than for a duplicate', () => {
    // A threshold near the dedupe value would call every camera wobble a cut
    // and report a frantic edit on handheld footage.
    expect(CUT_MAD).toBeGreaterThan(DUPLICATE_MAD * 5);
  });

  it('reports the hook pace separately from the whole', () => {
    // A fast hook on a slow video and a uniformly fast video are different
    // edits; a blended average hides which one this is.
    const frames = [];
    for (let t = 0; t < 10; t++) frames.push(frame(t, t % 2 ? 10 : 200)); // cut every second
    for (let t = 10; t < 120; t++) frames.push(frame(t, 10));             // then nothing
    const r = analyseAllFrames(frames, 120);
    expect(r.hookCutsPerMinute).toBeGreaterThan(r.cutsPerMinute);
  });

  it('uses the median shot length, not the mean', () => {
    // One long outro drags a mean away from what the video feels like.
    const frames = [frame(0, 10), frame(1, 200), frame(2, 10)];
    const r = analyseAllFrames(frames, 300);
    expect(r.medianShotSeconds).toBeLessThan(300);
  });

  it('survives an empty read', () => {
    expect(analyseAllFrames([], 30).shots).toEqual([]);
  });
});

describe('keyframesForShots', () => {
  it('returns one frame per shot, capped', () => {
    const frames = [];
    for (let t = 0; t < 200; t++) frames.push(frame(t, t % 2 ? 10 : 200));
    const r = analyseAllFrames(frames, 200);
    expect(keyframesForShots(r, 10)).toHaveLength(10);
  });
});

describe('stamp', () => {
  it('formats for lining frames up with the transcript', () => {
    expect(stamp(0)).toBe('0:00');
    expect(stamp(9)).toBe('0:09');
    expect(stamp(75)).toBe('1:15');
    expect(stamp(3671)).toBe('1:01:11');
  });
});

// The report is the only thing the model sees about a video it cannot play.
// These pin the properties that stop it inventing the parts it was not shown.

import { describe, it, expect } from 'vitest';
import { buildTimeline, buildWatchReport, wordsPerMinute, silenceRatio } from '@/lib/video/watch';
import { analyseAllFrames, THUMB_SIDE } from '@/lib/video/frames';

const flat = (v: number) => new Uint8Array(THUMB_SIDE * THUMB_SIDE).fill(v);

describe('buildTimeline', () => {
  it('interleaves frames and speech in time order', () => {
    const out = buildTimeline({
      durationSeconds: 10,
      frameTimestamps: [0, 5],
      transcript: [{ t: 1, text: 'Hello' }, { t: 6, text: 'Goodbye' }],
    });
    expect(out.split('\n')).toEqual([
      '[frame at 0:00]',
      '0:01  Hello',
      '[frame at 0:05]',
      '0:06  Goodbye',
    ]);
  });

  it('shows the frame before the words at the same second', () => {
    // You see the cut, then hear the line.
    const out = buildTimeline({
      durationSeconds: 5, frameTimestamps: [2], transcript: [{ t: 2, text: 'Now' }],
    });
    expect(out.indexOf('[frame at 0:02]')).toBeLessThan(out.indexOf('Now'));
  });

  it('keeps a frame with no speech at its timestamp', () => {
    // A silent shot is a fact about the video; dropping it would make the
    // visual track look shorter than it is.
    const out = buildTimeline({ durationSeconds: 5, frameTimestamps: [0, 3], transcript: [] });
    expect(out).toContain('[frame at 0:03]');
  });

  it('drops empty cues rather than printing blank lines', () => {
    const out = buildTimeline({
      durationSeconds: 5, frameTimestamps: [], transcript: [{ t: 1, text: '   ' }],
    });
    expect(out).toBe('');
  });
});

describe('delivery measures', () => {
  it('counts words per minute', () => {
    const t = [{ t: 0, text: 'one two three four five' }, { t: 1, text: 'six seven eight nine ten' }];
    expect(wordsPerMinute(t, 60)).toBe(10);
    expect(wordsPerMinute(t, 30)).toBe(20);
  });

  it('reports no speech as fully silent rather than dividing by zero', () => {
    expect(wordsPerMinute([], 60)).toBe(0);
    expect(silenceRatio([], 60)).toBe(1);
  });

  it('survives a zero duration', () => {
    expect(wordsPerMinute([{ t: 0, text: 'hi' }], 0)).toBe(0);
    expect(silenceRatio([{ t: 0, text: 'hi' }], 0)).toBe(0);
  });
});

describe('buildWatchReport', () => {
  const frames = [];
  for (let t = 0; t < 30; t++) frames.push({ t, thumb: flat(t % 5 === 0 ? 200 : 10) });
  const pace = analyseAllFrames(frames, 30);

  const report = buildWatchReport({
    title: 'Competitor ad',
    durationSeconds: 30,
    frameTimestamps: [0, 5, 10],
    transcript: [{ t: 0, text: 'Stop scrolling.' }, { t: 4, text: 'Here is why.' }],
    pace,
  });

  it('says the pace numbers came from every frame', () => {
    // The distinction the user asked about: every frame is ANALYSED even though
    // only some are attached, and the report has to make that legible.
    expect(report).toContain('every frame');
    expect(report).toContain(`${pace.framesAnalysed} frames read`);
  });

  it('carries the script, the pace and the delivery, not just stills', () => {
    expect(report).toContain('Stop scrolling.');
    expect(report).toContain('cuts per minute');
    expect(report).toContain('words per minute');
  });

  it('reports the hook pace separately', () => {
    expect(report).toContain('first 10 seconds');
  });

  it('tells the model not to describe footage it was not shown', () => {
    // A model given stills and a transcript will otherwise narrate the gaps,
    // and a confident invention about a competitor's ad is worse than a gap.
    expect(report).toMatch(/do not describe footage you were not shown/i);
  });

  it('labels the silence figure as an estimate', () => {
    // It is derived from cue coverage, not from the waveform. Saying so is the
    // difference between a measurement and a number someone will quote.
    expect(report).toMatch(/estimated/i);
  });

  it('works with no pace report at all', () => {
    // A URL analysed by a third party has a transcript and no frame access.
    const bare = buildWatchReport({
      durationSeconds: 10, frameTimestamps: [], transcript: [{ t: 0, text: 'Hi' }],
    });
    expect(bare).toContain('Hi');
    expect(bare).not.toContain('cuts per minute');
  });
});

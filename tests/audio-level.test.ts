// The level meter's arithmetic, tested against synthetic buffers.
//
// This is what the dictation control rests on. A meter that reads high on
// silence, or flat on speech, is worse than no meter at all — it is the thing
// telling you the microphone works, so when it lies you trust it and lose the
// recording. The component itself is MediaRecorder and DOM, which this project
// has no browser test environment for; this is the part that can be proven.

import { describe, it, expect } from 'vitest';
import {
  rmsFromTimeDomain, levelFromRms, isAudible, pushLevel, METER_BARS, SILENCE_FLOOR,
} from '../lib/audio/level';

/** getByteTimeDomainData centres the waveform on 128. */
const silence = () => new Uint8Array(256).fill(128);
const tone = (amplitude: number) =>
  Uint8Array.from({ length: 256 }, (_, i) => 128 + Math.round(Math.sin((i / 256) * Math.PI * 8) * 127 * amplitude));

describe('reading the level', () => {
  it('reads digital silence as zero', () => {
    expect(rmsFromTimeDomain(silence())).toBe(0);
  });

  it('rises with amplitude', () => {
    const quiet = rmsFromTimeDomain(tone(0.05));
    const loud = rmsFromTimeDomain(tone(0.5));
    expect(loud).toBeGreaterThan(quiet);
  });

  it('never exceeds 1 even at full scale', () => {
    expect(rmsFromTimeDomain(tone(1))).toBeLessThanOrEqual(1);
  });

  it('survives an empty buffer instead of returning NaN', () => {
    // A NaN here would render as a bar of height NaN and break the row.
    expect(rmsFromTimeDomain(new Uint8Array(0))).toBe(0);
  });
});

describe('turning level into a bar', () => {
  it('makes ordinary speech visibly move the meter', () => {
    // The point of the gain. Speech sits around 0.05-0.15 RMS; ungained it
    // renders as a flat line and a working microphone looks broken.
    const level = levelFromRms(rmsFromTimeDomain(tone(0.12)));
    expect(level).toBeGreaterThan(0.15);
  });

  it('clamps a loud click to the top rather than overflowing the row', () => {
    expect(levelFromRms(rmsFromTimeDomain(tone(1)))).toBe(1);
  });

  it('never returns a negative height', () => {
    expect(levelFromRms(-1)).toBe(0);
  });
});

describe('deciding whether anything was heard', () => {
  it('does not count silence as audio', () => {
    // Otherwise "nothing was picked up" can never be told from "you said
    // nothing", and those have completely different remedies.
    expect(isAudible(rmsFromTimeDomain(silence()))).toBe(false);
  });

  it('does not count room tone as audio', () => {
    expect(isAudible(rmsFromTimeDomain(tone(0.01)))).toBe(false);
  });

  it('counts speech as audio', () => {
    expect(isAudible(rmsFromTimeDomain(tone(0.12)))).toBe(true);
  });

  it('has a floor above zero, so mic self-noise is not signal', () => {
    expect(SILENCE_FLOOR).toBeGreaterThan(0);
  });
});

describe('the rolling window', () => {
  it('keeps its length so the meter never changes width', () => {
    let w = new Array(METER_BARS).fill(0);
    for (let i = 0; i < 50; i++) w = pushLevel(w, Math.random());
    expect(w).toHaveLength(METER_BARS);
  });

  it('puts the newest sample on the right — the meter scrolls left', () => {
    const w = pushLevel(new Array(METER_BARS).fill(0), 0.9);
    expect(w[w.length - 1]).toBe(0.9);
    expect(w[0]).toBe(0);
  });
});

// Audio level maths for the dictation meter.
//
// Extracted from the component so it can be TESTED. The rest of VoiceInput is
// MediaRecorder and DOM, which this project has no browser test environment
// for — but this part is arithmetic over a byte buffer, it is the part that is
// easy to get subtly wrong, and it is what the whole control rests on: if the
// level is wrong the meter lies, and a meter that lies is worse than no meter,
// because it is the thing telling you the microphone works.

/** Bars in the meter. Enough to read as a waveform, few enough to stay legible
 *  at composer height. */
export const METER_BARS = 14;

/** Speech sits low in the raw RMS range — normal talking is around 0.05-0.15,
 *  not near 1. Unscaled, a working microphone renders as a flat line and looks
 *  broken. */
const GAIN = 4;

/** Below this, treat it as silence rather than signal. Room tone and mic
 *  self-noise are never exactly zero, so a naive `rms > 0` would report that
 *  audio was heard from a muted input — the precise mistake that makes "nothing
 *  was picked up" impossible to tell from "you did not say anything". */
export const SILENCE_FLOOR = 0.02;

/**
 * Root-mean-square amplitude of a time-domain buffer, normalised to 0..1.
 *
 * getByteTimeDomainData centres the waveform on 128, so each sample is offset
 * from that midpoint rather than from zero. RMS rather than peak because a
 * single click should not slam the meter to full while quiet speech reads as
 * nothing.
 */
export function rmsFromTimeDomain(buf: Uint8Array): number {
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

/** Bar height as a 0..1 fraction, gained and clamped. */
export function levelFromRms(rms: number): number {
  return Math.min(1, Math.max(0, rms * GAIN));
}

/** Whether this buffer carries real signal, as opposed to a silent or dead
 *  input. Drives the difference between "that was too short" and "check the
 *  microphone is not muted". */
export function isAudible(rms: number): boolean {
  return rms > SILENCE_FLOOR;
}

/** Push a new level onto the rolling window, oldest first — the meter scrolls
 *  left, so the newest sample is always the rightmost bar. */
export function pushLevel(window: number[], level: number): number[] {
  return [...window.slice(1), level];
}

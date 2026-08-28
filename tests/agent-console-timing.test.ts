// Per-step timing and the aggregate step-count header added to
// src/components/AgentConsole.tsx.
//
// These pin the two pure functions extracted for exactly this reason — no DOM
// test environment exists in this project (vitest.config.ts runs 'node' and
// only collects tests/**/*.test.ts) — so the actual functions the component
// calls (formatDuration, countRealSteps) are imported and driven directly,
// the same pattern tests/composer-attachment-clearing.test.ts uses for
// attachmentsForTurn/clearSentAttachments.

import { describe, it, expect } from 'vitest';
import { formatDuration, countRealSteps, type Step } from '@/components/AgentConsole';

describe('formatDuration', () => {
  it('formats sub-second durations with one decimal place, not milliseconds', () => {
    expect(formatDuration(400)).toBe('0.4s');
  });

  it('formats whole seconds under a minute with no decimal', () => {
    expect(formatDuration(6000)).toBe('6s');
    expect(formatDuration(59000)).toBe('59s');
  });

  it('formats exactly 60s as 1m 0s', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
  });

  it('formats minutes and seconds past a minute', () => {
    expect(formatDuration(88000)).toBe('1m 28s');
  });

  it('clamps non-finite or negative input to 0 rather than printing garbage', () => {
    expect(formatDuration(-500)).toBe('0.0s');
    expect(formatDuration(NaN)).toBe('0.0s');
  });
});

describe('countRealSteps', () => {
  const doneThought = (over: Partial<Step> = {}): Step =>
    ({ kind: 'thought', text: 'Checking your brands', done: true, ...over } as Step);
  const doneTool = (over: Partial<Step> = {}): Step =>
    ({ kind: 'tool', label: 'Searching Notion', done: true, ...over } as Step);

  it('counts real thought and tool steps', () => {
    const steps: Step[] = [doneThought(), doneTool()];
    expect(countRealSteps(steps)).toBe(2);
  });

  it('DECISION: a synthetic placeholder does not count', () => {
    // The exact "Queued — starting once the first task has a thread…" shape
    // pushed by run() while a second concurrent turn waits for a conversation
    // id (~line 791), and the step_start "working" line pushed by
    // handleEvent (~line 943). Neither is a step the agent took.
    const placeholder: Step = {
      kind: 'thought',
      text: 'Queued — starting once the first task has a thread…',
      done: false,
      synthetic: true,
    } as Step;
    expect(countRealSteps([placeholder])).toBe(0);
  });

  it('THE CASE THAT MATTERS: replacing a placeholder with a real step increases the count by exactly one — never a visible jump', () => {
    // Simulates the in-place promotion handleEvent does: the placeholder
    // object has `synthetic` deleted and its text overwritten when the real
    // 'thought' event for the same slot arrives.
    const steps: Step[] = [
      { kind: 'thought', text: 'Queued — starting once the first task has a thread…', done: false, synthetic: true } as Step,
    ];
    const before = countRealSteps(steps);
    expect(before).toBe(0);

    // Promote in place, exactly like handleEvent's pendingPlaceholder branch.
    const placeholder = steps[0] as any;
    placeholder.text = 'Checking your brands';
    delete placeholder.synthetic;

    const after = countRealSteps(steps);
    expect(after).toBe(1);
    // Not 2, not 0 — one real step now exists where zero counted before.
    expect(after - before).toBe(1);
  });

  it('excludes error and note rows — they are not steps taken', () => {
    const steps: Step[] = [
      { kind: 'error', text: 'Connection failed. Try again.' } as Step,
      { kind: 'note', text: "won't ask again this chat" } as Step,
      doneThought(),
    ];
    expect(countRealSteps(steps)).toBe(1);
  });

  it('counts steps regardless of done state — the header counts steps taken so far, not steps finished', () => {
    const steps: Step[] = [doneThought(), { kind: 'tool', label: 'Searching Notion', done: false } as Step];
    expect(countRealSteps(steps)).toBe(2);
  });

  it('an empty or missing array counts as zero', () => {
    expect(countRealSteps([])).toBe(0);
    expect(countRealSteps(undefined as any)).toBe(0);
  });
});

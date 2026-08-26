// The step trace is the only window into a fan-out, and it was lying: three
// delegates announce at once, the client resolved "the previous pending step"
// on every event, and two of the three showed a tick while all three were still
// running. These pin the reducer rule that fixes it.
//
// This tests the reduction logic in isolation — the project has no DOM test
// environment — mirroring the branch in AgentConsole's event handler.

import { describe, it, expect } from 'vitest';

type Step =
  | { kind: 'thought'; text: string; done: boolean; parallel?: boolean; key?: string; ok?: boolean; observation?: string }
  | { kind: 'tool'; label: string; done: boolean; ok?: boolean; observation?: string };

type Evt =
  | { type: 'step_start'; text: string; parallel?: boolean; key?: string }
  | { type: 'observation'; text: string; ok: boolean; key?: string };

function reduce(steps: Step[], e: Evt): Step[] {
  const next = steps.map((s) => ({ ...s })) as Step[];
  if (e.type === 'observation' && e.key) {
    const own = next.find((s) => 'key' in s && s.key === e.key);
    if (own && own.kind === 'thought') { own.done = true; own.ok = e.ok; own.observation = e.text; }
    return next;
  }
  const prev = [...next].reverse().find((s) => !s.done && !('parallel' in s && s.parallel));
  if (prev) prev.done = true;
  if (e.type === 'step_start') {
    next.push({ kind: 'thought', text: e.text, done: false, ...(e.parallel ? { parallel: true, key: e.key } : {}) });
  }
  return next;
}

describe('fan-out step trace', () => {
  const start = (name: string, id: string): Evt =>
    ({ type: 'step_start', text: `${name} is working…`, parallel: true, key: `delegate:${id}` });

  it('leaves every delegate open while they all run', () => {
    let steps: Step[] = [];
    for (const [n, id] of [['Vale', 'a'], ['Kai', 'b'], ['Iris', 'c']]) steps = reduce(steps, start(n, id));
    expect(steps).toHaveLength(3);
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it('closes only the delegate its observation names', () => {
    let steps: Step[] = [];
    for (const [n, id] of [['Vale', 'a'], ['Kai', 'b'], ['Iris', 'c']]) steps = reduce(steps, start(n, id));
    steps = reduce(steps, { type: 'observation', text: 'Kai: found three angles.', ok: true, key: 'delegate:b' });
    expect(steps.map((s) => s.done)).toEqual([false, true, false]);
    expect((steps[1] as any).observation).toContain('three angles');
  });

  it('closes a delegate that failed, so it cannot spin forever', () => {
    let steps: Step[] = [reduce([], start('Vale', 'a'))[0]];
    steps = reduce(steps, { type: 'observation', text: 'Vale hit a problem: timeout', ok: false, key: 'delegate:a' });
    expect(steps[0].done).toBe(true);
    expect((steps[0] as any).ok).toBe(false);
  });

  it('still auto-resolves sequential steps', () => {
    // The old rule is right everywhere else and must not regress.
    let steps: Step[] = [];
    steps = reduce(steps, { type: 'step_start', text: 'Thinking…' });
    steps = reduce(steps, { type: 'step_start', text: 'Working…' });
    expect(steps.map((s) => s.done)).toEqual([true, false]);
  });

  it('does not let a later sequential step tick an open delegate', () => {
    // The coordinator's synthesis step starts while delegates may still be open.
    let steps: Step[] = [];
    steps = reduce(steps, start('Iris', 'c'));
    steps = reduce(steps, { type: 'step_start', text: 'Pulling it together…' });
    expect(steps[0].done).toBe(false);
  });
});

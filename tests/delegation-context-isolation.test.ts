// The delegation context is per-turn, not per-process.
//
// DEFECT THIS PINS (lib/capabilities/delegation.ts): the active turn used to
// live in a module-level singleton — `let activeTurn` — set at the top of
// runAgent/runAgentStream and cleared in their `finally`. Sub-runs and
// overlapping turns execute concurrently, so whichever one finished FIRST
// cleared the context out from under every other turn still in flight. Both
// things that read it were unreliable as a result:
//
//   * the depth cap (`turn?.isDelegate`) — a delegate could read null and
//     believe it was a top-level turn, so it was allowed to consult another
//     specialist, which is the recursion the cap exists to stop; and
//   * the per-turn delegation counter, keyed on `turn?.id` — spend could be
//     attributed to a sibling's id, or to no id at all.
//
// Reproduced with the old shape before the fix (two concurrent turns, the
// short one finishing first): the LONG turn read `null` where it should have
// read its own context. AsyncLocalStorage isolates each turn's store to its
// own async execution context, so the same interleaving now reads correctly.
//
// These tests exercise the storage directly rather than through the agent
// loop: the defect is in the storage mechanism, and driving a full turn to
// reach it would test the loop's mocks more than the property.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setDelegationContext,
  getDelegationContext,
  beginDelegationScope,
  endDelegationScope,
} from '@/lib/capabilities/delegation';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mirrors what runAgent/runAgentStream do around a turn: set the context
 *  synchronously on entry, do async work, clear it in `finally`. */
async function turn<T>(id: string, isDelegate: boolean, ms: number, body: () => T): Promise<T> {
  beginDelegationScope(id);
  setDelegationContext({ id, isDelegate });
  try {
    await sleep(ms);
    return body();
  } finally {
    endDelegationScope(id);
    setDelegationContext(null);
  }
}

beforeEach(() => {
  setDelegationContext(null);
});

describe('delegation context isolation', () => {
  it('a turn still reads its OWN context after a concurrent turn has finished and cleared', async () => {
    // B finishes first and runs its `finally`. Under the old singleton this is
    // exactly what set A's context to null while A was still running.
    const [a, b] = await Promise.all([
      turn('turn-A', false, 60, () => getDelegationContext()),
      turn('turn-B', false, 10, () => getDelegationContext()),
    ]);
    expect(a?.id).toBe('turn-A');
    expect(b?.id).toBe('turn-B');
  });

  it('never lets one turn read a sibling turn\'s id', async () => {
    const seen = await Promise.all([
      turn('turn-1', false, 40, () => getDelegationContext()?.id),
      turn('turn-2', false, 20, () => getDelegationContext()?.id),
      turn('turn-3', false, 5, () => getDelegationContext()?.id),
    ]);
    expect(seen).toEqual(['turn-1', 'turn-2', 'turn-3']);
  });

  it('keeps isDelegate true for a delegate running alongside a finishing top-level turn', async () => {
    // The depth cap reads isDelegate. If a concurrent turn's cleanup can clear
    // it, a delegate is free to consult another specialist — unbounded
    // recursion, which is precisely what the cap exists to prevent.
    const [delegate] = await Promise.all([
      turn('delegate-1', true, 50, () => getDelegationContext()),
      turn('toplevel-1', false, 5, () => getDelegationContext()),
    ]);
    expect(delegate?.isDelegate).toBe(true);
  });

  it('a later turn reads its own context, never the previous turn\'s', async () => {
    // Sequential turns, which is the ordinary case: each one must see itself.
    const first = await turn('turn-first', false, 5, () => getDelegationContext()?.id);
    const second = await turn('turn-second', true, 5, () => getDelegationContext());
    expect(first).toBe('turn-first');
    expect(second?.id).toBe('turn-second');
    expect(second?.isDelegate).toBe(true);
  });

  // DELIBERATELY NOT ASSERTED: that the store reads null in the CALLER once an
  // awaited turn has returned. It does not, and it does not need to.
  // setDelegationContext runs synchronously at the top of runAgent, before its
  // first await, so enterWith writes into the CALLER's async context; the
  // matching enterWith(null) in the `finally` runs in the turn's own post-await
  // context and does not propagate back out. A caller is therefore left holding
  // the last turn's value until the next turn overwrites it.
  //
  // That is harmless for both readers: the depth cap and the counter are read
  // INSIDE a turn, where the tests above prove the value is correct, and every
  // turn sets its own context on entry. An earlier draft of this file asserted
  // the teardown-to-null instead and failed — the assertion was wrong, not the
  // code. Recorded here so the next person does not re-add it.
});

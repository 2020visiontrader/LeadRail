// The expiry exists to stop a STALE PROPOSAL running against a changed world.
// It was also, accidentally, throwing away decisions that were seconds old —
// because one clock was answering two different questions.

import { describe, it, expect } from 'vitest';
import { expiryForGate, expiryAfterDecision, isPastDue } from '@/lib/approvals/store';

const MIN = 60_000;

describe('approval clock', () => {
  it('restarts from the decision, not from when the proposal was raised', () => {
    // T+0 raised with a 30-minute window; the operator reads it at T+29 and
    // approves. Before this, the agent had 60 seconds to reach the execution
    // step or the approval died — and a slow fan-out takes minutes.
    const now = new Date('2026-08-26T12:29:00Z');
    const raisedAt = new Date('2026-08-26T12:00:00Z');
    const originalExpiry = expiryForGate('spend', raisedAt)!;

    const extended = expiryAfterDecision(originalExpiry, now)!;
    expect(Date.parse(extended)).toBeGreaterThan(Date.parse(originalExpiry));
    // Still alive well after the original window would have closed.
    expect(isPastDue(extended, new Date('2026-08-26T12:35:00Z'))).toBe(false);
  });

  it('never SHORTENS a longer remaining window', () => {
    // external_send gets 60 minutes. A decision taken a minute in must not cut
    // that down to the execution window.
    const now = new Date('2026-08-26T12:01:00Z');
    const long = expiryForGate('external_send', new Date('2026-08-26T12:00:00Z'))!;
    expect(expiryAfterDecision(long, now)).toBe(long);
  });

  it('still lapses eventually — approved and forgotten must not fire later', () => {
    // The point is a SHORTER, fresher window, not an unlimited one.
    const now = new Date('2026-08-26T12:00:00Z');
    const extended = expiryAfterDecision(expiryForGate('spend', now), now)!;
    expect(isPastDue(extended, new Date('2026-08-26T14:00:00Z'))).toBe(true);
  });

  it('leaves a never-lapsing approval alone', () => {
    // A proposal with no gate never had an expiry; a decision must not invent
    // one and start killing approvals that used to be indefinite.
    expect(expiryAfterDecision(null)).toBeNull();
  });
});

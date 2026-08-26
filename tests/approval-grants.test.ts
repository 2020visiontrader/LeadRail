// A standing grant runs paid actions with no human in the loop, so the tests
// that matter are the ones about what it REFUSES to cover.

import { describe, it, expect } from 'vitest';
import { grantableGate } from '@/lib/agent/loop';
import { CAPABILITIES } from '@/lib/capabilities/registry';

describe('what may be pre-approved', () => {
  it('never covers a destructive action', () => {
    // Every other gate commits something recoverable — money can be refunded, a
    // message followed up, a rule turned off — and the case for not asking
    // twenty times is that the twentieth ask is not being read. A destructive
    // action has no version of that argument.
    expect(grantableGate('destructive')).toBe(false);
  });

  it('covers the gates where repetition is the real risk', () => {
    for (const gate of ['spend', 'external_send', 'standing_rule', 'internal_write']) {
      expect(grantableGate(gate)).toBe(true);
    }
  });

  it('never covers an action that declared no gate', () => {
    // An external MCP tool has no first-party capability, so nothing described
    // what it does. A grant is a decision about a known risk.
    expect(grantableGate(undefined)).toBe(false);
    expect(grantableGate('')).toBe(false);
  });

  it('never covers a gate class nobody has reviewed', () => {
    // A new gate must not inherit pre-approval by existing.
    expect(grantableGate('something_new')).toBe(false);
  });

  it('leaves every destructive capability in the registry ask-every-time', () => {
    const destructive = CAPABILITIES.filter((c) => c.gate === 'destructive');
    expect(destructive.length).toBeGreaterThan(0); // the check would be vacuous otherwise
    for (const c of destructive) {
      expect(grantableGate(c.gate)).toBe(false);
    }
  });
});

// tests/memory-guard.test.ts
//
// factRejectionReason is the single write-time guard for durable memory
// (agent_memory), read back into EVERY future prompt for an account. Two
// classes of thing must never land there: secrets (existing coverage below)
// and, for carryover-sourced facts specifically, unverified performance
// claims — a carryover memo is the model summarizing its OWN prior turn, with
// no real analytics access, so a metric-shaped claim in one can only be a
// restated or invented number. Promoting it risks the model citing its own
// unverified claim back to itself as established fact indefinitely. This is
// gated on `source`: 'capability' (rememberFact, the model deciding live,
// mid-turn) is exempt — only 'carryover' (passive, unattended promotion) is
// held to the stricter bar.

import { describe, it, expect } from 'vitest';
import { factRejectionReason } from '@/lib/agent/memory';

describe('factRejectionReason', () => {
  it('rejects secrets and opaque tokens regardless of source', () => {
    expect(factRejectionReason('sk-live-abcdefghijklmnopqrstuvwxyz0123456789')).toBeTruthy();
    expect(factRejectionReason('sk-live-abcdefghijklmnopqrstuvwxyz0123456789', 'carryover')).toBeTruthy();
  });

  it('rejects empty and over-length facts', () => {
    expect(factRejectionReason('')).toBe('empty');
    expect(factRejectionReason('  ')).toBe('empty');
    expect(factRejectionReason('x'.repeat(501))).toMatch(/too long/);
  });

  it('accepts an ordinary preference fact from either source', () => {
    expect(factRejectionReason('Sarah prefers Thursday afternoon meetings')).toBeNull();
    expect(factRejectionReason('Sarah prefers Thursday afternoon meetings', 'carryover')).toBeNull();
  });

  it('rejects an unverified performance metric ONLY when source is carryover', () => {
    const claim = 'The "Quick check on 0:47 drop fix" subject line got 64% open rate';
    expect(factRejectionReason(claim, 'carryover')).toMatch(/unverified performance metric/);
    // The model deciding live, with real tool access, is not held to the same
    // bar — rememberFact is a deliberate action, not a passive summary.
    expect(factRejectionReason(claim, 'capability')).toBeNull();
    expect(factRejectionReason(claim)).toBeNull(); // default source is 'capability'
  });

  it('does not false-positive on numbers that are not performance metrics', () => {
    expect(factRejectionReason('The venture targets companies with 50% remote workforces', 'carryover')).toBeNull();
    expect(factRejectionReason('Acme Corp has 12% market share in their niche', 'carryover')).toBeNull();
  });
});

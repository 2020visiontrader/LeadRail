// Fingerprinting is what makes a machine-fed board usable. One misconfiguration
// in this platform's history produced 5,476 rejected webhooks; if each had
// become a card, the board would have been the outage.
//
// Both directions matter, and the second is the dangerous one:
//   - identical failures MUST merge, or the board drowns
//   - different failures MUST NOT merge, or a ticket silently absorbs an
//     unrelated bug and hides it completely

import { describe, it, expect } from 'vitest';
import { fingerprintFailure, normalizeMessage, titleFor } from '../lib/support/fingerprint';

const fp = (message: string, route = '/api/x', statusCode: number | null = 500) =>
  fingerprintFailure({ route, statusCode, message });

describe('merging identical failures', () => {
  it('ignores the id that varies between occurrences', () => {
    expect(fp('lead 41f2c8de-1111-4b2a-9c3d-aaaaaaaaaaaa not found'))
      .toBe(fp('lead 9ab30000-2222-4b2a-9c3d-bbbbbbbbbbbb not found'));
  });

  it('ignores counts, sizes and durations', () => {
    expect(fp('timed out after 3000ms')).toBe(fp('timed out after 87ms'));
  });

  it('ignores the specific email or url that triggered it', () => {
    expect(fp('could not deliver to alice@example.com'))
      .toBe(fp('could not deliver to bob@other.co.uk'));
  });

  it('ignores quoted values', () => {
    expect(fp('column "allow_auto" not found')).toBe(fp('column "brand_id" not found'));
  });

  it('collapses a burst of one failure to a single identity', () => {
    const burst = Array.from({ length: 5476 }, (_, i) =>
      fp(`signature mismatch for delivery ${i} at 2026-08-24T17:0${i % 10}:00Z`));
    expect(new Set(burst).size).toBe(1);
  });
});

describe('keeping different failures apart', () => {
  it('separates different errors on the same route', () => {
    expect(fp('signature mismatch')).not.toBe(fp('payload too large'));
  });

  it('separates the same error on different routes', () => {
    expect(fp('unauthorized', '/api/a')).not.toBe(fp('unauthorized', '/api/b'));
  });

  it('separates the same message under different status codes', () => {
    expect(fp('failed', '/api/x', 500)).not.toBe(fp('failed', '/api/x', 503));
  });
});

describe('inspectability', () => {
  it('exposes the normalised shape, so a merge can be explained', () => {
    // A dedup rule nobody can inspect is one nobody can trust.
    expect(normalizeMessage('Lead 41f2c8de-1111-4b2a-9c3d-aaaaaaaaaaaa took 45ms'))
      .toBe('lead <id> took <n>');
  });

  it('titles a card from the shape, not from whichever occurrence arrived first', () => {
    const t = titleFor({ route: '/api/webhooks/meta', statusCode: 401, message: 'Invalid signature for user 12345' });
    expect(t).toContain('/api/webhooks/meta');
    expect(t).toContain('401');
    expect(t).not.toContain('12345');
  });
});

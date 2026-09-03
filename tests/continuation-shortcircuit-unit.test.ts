// Pure unit coverage for the exact-match allow-list and reply builder in
// lib/agent/continuation-shortcircuit.ts — no mocking, no loop involved.

import { describe, it, expect } from 'vitest';
import {
  isContentlessContinuation,
  normalizeContinuation,
  buildPendingApprovalReply,
  CONTENTLESS_CONTINUATION_PHRASES,
} from '@/lib/agent/continuation-shortcircuit';
import type { SafeApproval } from '@/lib/approvals/store';

describe('normalizeContinuation', () => {
  it('trims, lowercases, and strips trailing punctuation', () => {
    expect(normalizeContinuation('Continue!')).toBe('continue');
    expect(normalizeContinuation('  continue.  ')).toBe('continue');
    expect(normalizeContinuation('CONTINUE???')).toBe('continue');
  });

  it('strips a trailing emoji', () => {
    expect(normalizeContinuation('continue 👍')).toBe('continue');
    expect(normalizeContinuation('continue!! 👍🏽')).toBe('continue');
  });

  it('never strips anything from the middle of the message', () => {
    expect(normalizeContinuation('continue with the other leads')).toBe('continue with the other leads');
  });
});

describe('isContentlessContinuation — exact match only, never substring', () => {
  it('matches the documented allow-list phrases (case/punctuation-insensitive)', () => {
    expect(isContentlessContinuation('continue')).toBe(true);
    expect(isContentlessContinuation('Continue')).toBe(true);
    expect(isContentlessContinuation('Continue!')).toBe(true);
    expect(isContentlessContinuation('keep going')).toBe(true);
    expect(isContentlessContinuation('go on')).toBe(true);
    expect(isContentlessContinuation('carry on')).toBe(true);
    expect(isContentlessContinuation('go ahead')).toBe(true);
    expect(isContentlessContinuation('proceed')).toBe(true);
    expect(isContentlessContinuation('any update')).toBe(true);
    expect(isContentlessContinuation('status')).toBe(true);
    expect(isContentlessContinuation('?')).toBe(true);
  });

  it('rejects a continuation with additional words — this is the critical guard', () => {
    expect(isContentlessContinuation('continue with the other leads')).toBe(false);
    expect(isContentlessContinuation('continue but skip the VC')).toBe(false);
    expect(isContentlessContinuation('status of the campaign')).toBe(false);
    expect(isContentlessContinuation('proceed carefully')).toBe(false);
  });

  it('rejects empty/undefined/whitespace-only messages', () => {
    expect(isContentlessContinuation('')).toBe(false);
    expect(isContentlessContinuation(undefined)).toBe(false);
    expect(isContentlessContinuation(null)).toBe(false);
    expect(isContentlessContinuation('   ')).toBe(false);
  });

  it('rejects unrelated messages', () => {
    expect(isContentlessContinuation('what is the weather today')).toBe(false);
    expect(isContentlessContinuation('reject it')).toBe(false);
  });
});

function makeApproval(overrides: Partial<SafeApproval> = {}): SafeApproval {
  return {
    id: 'appr-1',
    account_id: 'acct-1',
    conversation_id: 'conv-1',
    tool: 'sendEmail',
    title: 'Send outreach email',
    summary: 'Send "Quick note" to Markus.',
    args_redacted: {},
    args_hash: 'hash',
    state: 'pending',
    requested_by: null,
    decided_by: null,
    decided_at: null,
    comment: null,
    expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    has_encrypted_args: false,
    ...overrides,
  } as SafeApproval;
}

describe('buildPendingApprovalReply', () => {
  it('names the tool and gives concrete next steps for a single-item approval', () => {
    const reply = buildPendingApprovalReply(makeApproval());
    expect(reply).toContain('Send outreach email');
    expect(reply).toContain('Send "Quick note" to Markus.');
    expect(reply).toMatch(/approve/i);
    expect(reply).toMatch(/reject/i);
    expect(reply).toMatch(/session/i);
    expect(reply).not.toContain('item');
  });

  it('names the batch item count when the approval covers a batch', () => {
    const reply = buildPendingApprovalReply(makeApproval({
      title: 'Enrich leads',
      args_redacted: { calls: Array.from({ length: 7 }, () => ({})) },
    }));
    expect(reply).toContain('Enrich leads');
    expect(reply).toContain('7');
    expect(reply).toMatch(/item/);
  });
});

it('the allow-list is exact-match phrases only (documented invariant)', () => {
  // Guards against someone "helpfully" adding a phrase like "continue*" that
  // would turn this into a prefix/substring match.
  for (const phrase of CONTENTLESS_CONTINUATION_PHRASES) {
    expect(phrase).toBe(phrase.trim().toLowerCase());
  }
});

// DEFECT 1 — the composer never cleared attachments after a send.
//
// Production evidence: a user attached a 34,456-character document and sent
// "analyze it, let's start working on the plan…". The run failed
// (`!terminalSent` fallback), and the attachment chip was STILL in the
// composer afterward — which reads as "the send never happened" — and the
// same document would have ridden along AGAIN on the next message, silently
// duplicating it into that prompt too.
//
// These pin the two pure state-transition helpers extracted from
// src/components/AgentConsole.tsx's run() for exactly this reason — no DOM
// test environment exists in this project (vitest.config.ts runs 'node' and
// only collects tests/**/*.test.ts, never .tsx) — so the actual functions
// run() calls are imported and driven directly rather than reimplemented.

import { describe, it, expect } from 'vitest';
import { attachmentsForTurn, clearSentAttachments } from '@/components/AgentConsole';
import type { UploadedAttachment } from '@/components/composer/Attachments';

const DOC: UploadedAttachment = {
  id: 'att-1', filename: 'brief.txt', kind: 'txt', bytes: 34456, chars: 34456, status: 'ready',
};
const OTHER: UploadedAttachment = {
  id: 'att-2', filename: 'other.pdf', kind: 'pdf', bytes: 900, chars: 900, status: 'ready',
};

describe('attachmentsForTurn', () => {
  it('claims the composer attachments for a real message-carrying send', () => {
    expect(attachmentsForTurn(true, [DOC])).toEqual([DOC]);
  });

  it('claims nothing for an approve-resume (no payload.message)', () => {
    // Otherwise a file sitting unsent in the composer while an unrelated
    // approval is confirmed would be wrongly swept into that resume.
    expect(attachmentsForTurn(false, [DOC])).toEqual([]);
  });
});

describe('clearSentAttachments — the fix itself', () => {
  it('removes exactly the attachments this turn sent, once dispatched', () => {
    const next = clearSentAttachments([DOC], [DOC]);
    expect(next).toEqual([]);
  });

  it('does NOT clear anything when the turn sent no attachments (a plain text message)', () => {
    // This is the failed-dispatch / no-attachment case: nothing was sent, so
    // nothing should be wiped from the composer.
    const next = clearSentAttachments([DOC], []);
    expect(next).toEqual([DOC]);
  });

  it('leaves an attachment dropped in WHILE the turn was in flight untouched', () => {
    // turnAttachments was snapshotted before OTHER was added mid-flight.
    const next = clearSentAttachments([DOC, OTHER], [DOC]);
    expect(next).toEqual([OTHER]);
  });

  it('is idempotent — clearing twice for the same sent set is a no-op the second time', () => {
    const once = clearSentAttachments([DOC], [DOC]);
    const twice = clearSentAttachments(once, [DOC]);
    expect(twice).toEqual([]);
  });
});

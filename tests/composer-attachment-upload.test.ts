// Two defects found while adding the 10-document attachment cap to the
// composer (src/components/composer/Attachments.tsx).
//
// DEFECT — multi-file selection silently dropped every file but the last.
// The upload loop called `onChange([...attachments, result])` once per file
// inside a `for` loop. `attachments` there is the value the hook was called
// with — a closure fixed at call time — so every iteration read the SAME
// stale array and each onChange overwrote the one before it. Selecting three
// files at once left the composer with exactly one attachment, and it was
// unpredictable which one (a race with React's own re-render, not a fixed
// "first" or "last"). appendAttachments is what the hook now folds through
// with a LOCAL accumulator instead of re-reading the prop each time — see the
// comment on it in Attachments.tsx for the full account.
//
// There is no jsdom/renderHook setup in this project (vitest runs 'node' and
// only collects tests/**/*.test.ts — see vitest.config.ts), so the hook
// itself cannot be driven directly. What's testable, and what the hook's fix
// is actually built on, is the pure fold — this pins that the fold is
// correct and order-preserving, which is the property the fix depends on.
//
// DEFECT (adjacent, same change) — no cap existed on attachment count at all.
// clampForUpload is the pure arithmetic the hook now runs before accepting a
// selection, so a 12-file drop attaches the 10 that fit and reports the rest
// rejected instead of quietly accepting all 12.

import { describe, it, expect } from 'vitest';
import { appendAttachments, clampForUpload, MAX_ATTACHMENTS, type UploadedAttachment } from '@/components/composer/Attachments';

const doc = (id: string): UploadedAttachment => ({
  id, filename: `${id}.pdf`, kind: 'pdf', bytes: 100, chars: 100, status: 'ready',
});

describe('appendAttachments — the fold that replaced the stale-closure loop', () => {
  it('builds the list up in call order across repeated folds, the way the upload loop now calls it once per finished file', () => {
    let acc: UploadedAttachment[] = [];
    acc = appendAttachments(acc, [doc('a')]);
    acc = appendAttachments(acc, [doc('b')]);
    acc = appendAttachments(acc, [doc('c')]);
    expect(acc.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the array it was given — the old bug pattern (onChange racing a mutated shared array) depended on exactly this', () => {
    const original = [doc('a')];
    const next = appendAttachments(original, [doc('b')]);
    expect(original).toEqual([doc('a')]);
    expect(next).toEqual([doc('a'), doc('b')]);
    expect(next).not.toBe(original);
  });

  it('preserves whatever was already attached before the fold started', () => {
    const existing = [doc('pre-existing')];
    expect(appendAttachments(existing, [doc('new')]).map((a) => a.id)).toEqual(['pre-existing', 'new']);
  });
});

describe('clampForUpload — the 10-document cap', () => {
  it('accepts everything when well under the cap', () => {
    expect(clampForUpload(0, 3)).toEqual({ acceptCount: 3, rejectCount: 0 });
  });

  it('accepts exactly up to the cap and rejects the rest — the 12-file-drop case', () => {
    expect(clampForUpload(0, 12, MAX_ATTACHMENTS)).toEqual({ acceptCount: 10, rejectCount: 2 });
  });

  it('accounts for attachments already in flight, not just already attached', () => {
    // 7 attached + 2 uploading = 9 slots spoken for; 3 more offered, only 1 fits.
    expect(clampForUpload(9, 3, MAX_ATTACHMENTS)).toEqual({ acceptCount: 1, rejectCount: 2 });
  });

  it('rejects everything once already at the cap, rather than going negative', () => {
    expect(clampForUpload(10, 4, MAX_ATTACHMENTS)).toEqual({ acceptCount: 0, rejectCount: 4 });
  });

  it('never reports a negative reject count when nothing was offered', () => {
    expect(clampForUpload(10, 0, MAX_ATTACHMENTS)).toEqual({ acceptCount: 0, rejectCount: 0 });
  });
});

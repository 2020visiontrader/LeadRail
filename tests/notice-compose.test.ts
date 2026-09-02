// scripts/lib/notice.ts — the section-composition fix for BACKLOG 5c
// (residual): scripts/harvest-skills.ts and scripts/harvest-personas.ts both
// write the root NOTICE, and used to clobber each other because
// harvest-skills.ts regenerated the whole file wholesale. Proves the actual
// property the fix exists for: running both scripts' writers in EITHER order
// produces a byte-identical file, and each write is idempotent on its own.
//
// Exercises writeNoticeSection directly against a scratch file (the optional
// `path` param exists solely for this test — see the function's own
// comment) rather than the real end-to-end harvest scripts, which need
// upstream clones this sandbox does not have for 14 of harvest-skills.ts's
// 16 sources. The real end-to-end proof (both scripts against their actual
// clones, in both orders, byte-identical NOTICE) was run manually this
// session — see the task report — and is not repeatable in CI without those
// clones; this test pins the mechanism it depends on.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNoticeSection } from '@/scripts/lib/notice';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notice-test-'));
  path = join(dir, 'NOTICE');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SKILLS_BODY = 'Skill content section body — repo X, repo Y.';
const PERSONAS_BODY = 'Persona-template content section body — repo X, repo Z.';

describe('writeNoticeSection', () => {
  it('creates the file with just its own section on a fresh checkout (no NOTICE yet)', () => {
    expect(existsSync(path)).toBe(false);
    writeNoticeSection('SKILLS', SKILLS_BODY, path);
    const out = readFileSync(path, 'utf8');
    expect(out).toContain(SKILLS_BODY);
    expect(out).toContain('<!-- NOTICE:SKILLS:BEGIN -->');
    expect(out).toContain('<!-- NOTICE:SKILLS:END -->');
    // The other script's markers are present but empty — not missing.
    expect(out).toContain('<!-- NOTICE:PERSONAS:BEGIN -->\n\n<!-- NOTICE:PERSONAS:END -->');
  });

  it('REVERT-CHECK TARGET: writing PERSONAS after SKILLS preserves the SKILLS section', () => {
    writeNoticeSection('SKILLS', SKILLS_BODY, path);
    writeNoticeSection('PERSONAS', PERSONAS_BODY, path);
    const out = readFileSync(path, 'utf8');
    expect(out).toContain(SKILLS_BODY);
    expect(out).toContain(PERSONAS_BODY);
  });

  it('REVERT-CHECK TARGET: writing SKILLS after PERSONAS preserves the PERSONAS section', () => {
    writeNoticeSection('PERSONAS', PERSONAS_BODY, path);
    writeNoticeSection('SKILLS', SKILLS_BODY, path);
    const out = readFileSync(path, 'utf8');
    expect(out).toContain(SKILLS_BODY);
    expect(out).toContain(PERSONAS_BODY);
  });

  it('REVERT-CHECK TARGET: run order does not matter — the two orders produce a byte-identical file', () => {
    writeNoticeSection('SKILLS', SKILLS_BODY, path);
    writeNoticeSection('PERSONAS', PERSONAS_BODY, path);
    const orderA = readFileSync(path, 'utf8');

    const path2 = join(dir, 'NOTICE-2');
    writeNoticeSection('PERSONAS', PERSONAS_BODY, path2);
    writeNoticeSection('SKILLS', SKILLS_BODY, path2);
    const orderB = readFileSync(path2, 'utf8');

    expect(orderA).toBe(orderB);
  });

  it('re-running the same section is idempotent (no drift, no duplication)', () => {
    writeNoticeSection('SKILLS', SKILLS_BODY, path);
    writeNoticeSection('PERSONAS', PERSONAS_BODY, path);
    const once = readFileSync(path, 'utf8');
    writeNoticeSection('SKILLS', SKILLS_BODY, path);
    const twice = readFileSync(path, 'utf8');
    expect(twice).toBe(once);
  });

  it('changing one section only rewrites that section, leaving the other untouched', () => {
    writeNoticeSection('SKILLS', SKILLS_BODY, path);
    writeNoticeSection('PERSONAS', PERSONAS_BODY, path);
    writeNoticeSection('SKILLS', 'A completely different skills body.', path);
    const out = readFileSync(path, 'utf8');
    expect(out).not.toContain(SKILLS_BODY);
    expect(out).toContain('A completely different skills body.');
    expect(out).toContain(PERSONAS_BODY); // untouched
  });
});

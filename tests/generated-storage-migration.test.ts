// tests/generated-storage-migration.test.ts — public/generated/ must never
// come back.
//
// THE DEFECT THIS GUARDS AGAINST. Generated media and text deliverables were
// written to `public/generated/` on the server's local filesystem: gitignored
// (not in the build output, so destroyed on every deploy), served by Next.js
// with no auth and no account_id scoping (possession of the URL was access,
// across tenants), and — for character reference anchor images — the URL was
// then persisted into `character_refs.image_url`, so every conditioned
// generation broke the moment the file disappeared. The fix moved all four
// write sites (lib/capabilities/content.ts, lib/capabilities/workspace.ts,
// app/api/generate/image/route.ts, lib/capabilities/deliverables.ts) onto
// lib/storage.ts's private, tenant-prefixed, signed-URL buckets.
//
// This is a structural guard, not a behavioural one — the other tests in
// this file (and tests/deliverable-formats.test.ts,
// tests/character-ref-storage-path.test.ts) cover behaviour. This one
// follows tests/route-tenant-guard-audit.test.ts's pattern: grep every
// source file under lib/ and app/ for the pattern that reintroduces the bug,
// so it cannot come back silently in a new call site either.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';

const ROOT = process.cwd();

// Matches a write under the old local-disk path, in any of the shapes the
// four original sites used: 'public', 'generated' as adjacent string
// arguments to join()/resolve(), or a literal '/generated/' URL prefix
// returned to a caller. Deliberately broad — a near-miss should fail loud
// here rather than pass a narrow regex and still be the bug.
const FORBIDDEN_PATTERN = /public['"]\s*,\s*['"]generated|['"`]\/generated\//;

// Strip comments before matching, so a comment explaining or referencing the
// OLD path (as several of the fixed sites now do, in prose, to say what they
// no longer do) does not trip this guard — only actual code can reintroduce
// the bug. Crude but sufficient for TS/TSX: block comments, then line
// comments. Does not attempt to skip string literals that happen to contain
// "//", none of which occur in this codebase's storage paths.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const sourceFiles = fg.sync(['lib/**/*.ts', 'app/**/*.ts', 'app/**/*.tsx'], {
  cwd: ROOT,
  ignore: ['**/*.test.ts', '**/node_modules/**'],
}).sort();

describe('public/generated/ is not reintroduced anywhere in lib/ or app/', () => {
  it('found source files to scan (sanity check the glob itself)', () => {
    expect(sourceFiles.length).toBeGreaterThan(200);
  });

  it.each(sourceFiles)('%s', (rel) => {
    // lib/skills/harvested.ts and lib/agent/harvested-personas.ts are large
    // JSON-in-TS blobs of persona/skill prose harvested from elsewhere; they
    // are not code this app executes as a file-write path, and "generated"
    // appears in them only as ordinary English. Everything else must be
    // clean.
    if (rel === 'lib/skills/harvested.ts' || rel === 'lib/agent/harvested-personas.ts') return;
    const code = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    expect(
      FORBIDDEN_PATTERN.test(code),
      `${rel} matches the forbidden public/generated/ pattern (${FORBIDDEN_PATTERN.source}) outside a comment. ` +
        `Generated media and deliverables must be written through lib/storage.ts ` +
        `(uploadGenerated / DELIVERABLE_BUCKET), never to the local public/generated/ path.`,
    ).toBe(false);
  });
});

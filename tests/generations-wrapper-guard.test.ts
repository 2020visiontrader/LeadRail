// tests/generations-wrapper-guard.test.ts — every media generation site must
// go through the shared write path.
//
// THE DEFECT THIS GUARDS AGAINST. lib/generations/store.ts's
// recordMediaGeneration/recordExternalVideoGeneration is the ONE place that
// checks quota, uploads to GENERATED_BUCKET, and records a generations row.
// Migrations 086/087's history shows exactly how this class of bug happens
// here: four call sites each re-implemented "upload the generated file"
// independently and drifted (public/generated/ leaked back in more than
// once). A new image/video generation site that calls uploadGenerated()
// directly instead of going through the wrapper would upload the file and
// leave no ledger row — the exact "written but never read" shape CLAUDE.md
// names, mirrored: here it would be "generated but never recorded".
//
// This is a structural guard, modeled on
// tests/generated-storage-migration.test.ts: grep every source file for the
// bypass pattern, so it fails loud the moment a new call site reintroduces
// it, rather than depending on someone remembering to route through the
// wrapper.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';

const ROOT = process.cwd();

// The only file allowed to call uploadGenerated directly is the wrapper
// module itself — lib/generations/store.ts. Every other call is a bypass.
const ALLOWED_CALLERS = new Set(['lib/generations/store.ts', 'lib/storage.ts']);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const sourceFiles = fg.sync(['lib/**/*.ts', 'app/**/*.ts', 'app/**/*.tsx'], {
  cwd: ROOT,
  ignore: ['**/*.test.ts', '**/node_modules/**'],
}).sort();

describe('every image/video generation site calls uploadGenerated only through lib/generations/store.ts', () => {
  it('found source files to scan (sanity check the glob itself)', () => {
    expect(sourceFiles.length).toBeGreaterThan(200);
  });

  it.each(sourceFiles)('%s', (rel) => {
    if (ALLOWED_CALLERS.has(rel)) return;
    const code = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    // Matches an actual call, not the export declaration or an import list —
    // uploadGenerated( with anything before the paren that isn't "function".
    const bypass = /(?<!function )uploadGenerated\s*\(/.test(code);
    expect(
      bypass,
      `${rel} calls uploadGenerated() directly instead of going through ` +
        `lib/generations/store.ts's recordMediaGeneration/recordExternalVideoGeneration. ` +
        `A direct call uploads the file but records no generations row — the ledger this ` +
        `packet added becomes incomplete the moment a new site bypasses it.`,
    ).toBe(false);
  });
});

describe('every image generation capability/route calls the shared wrapper', () => {
  it('generateBrandImage (lib/capabilities/content.ts)', () => {
    const code = readFileSync(join(ROOT, 'lib/capabilities/content.ts'), 'utf8');
    expect(code).toMatch(/recordMediaGeneration/);
  });
  it('generateImage (lib/capabilities/workspace.ts)', () => {
    const code = readFileSync(join(ROOT, 'lib/capabilities/workspace.ts'), 'utf8');
    expect(code).toMatch(/recordMediaGeneration/);
  });
  it('POST /api/generate/image (app/api/generate/image/route.ts)', () => {
    const code = readFileSync(join(ROOT, 'app/api/generate/image/route.ts'), 'utf8');
    expect(code).toMatch(/recordMediaGeneration/);
  });
  it('generateBrandVideo (lib/capabilities/content.ts) records externally-hosted video', () => {
    const code = readFileSync(join(ROOT, 'lib/capabilities/content.ts'), 'utf8');
    expect(code).toMatch(/recordExternalVideoGeneration/);
  });
});

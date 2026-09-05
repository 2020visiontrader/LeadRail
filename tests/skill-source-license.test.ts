// tests/skill-source-license.test.ts — production seed carries real
// source/license, and the change-detection that repairs an already-seeded
// row actually flags a source/license mismatch.
//
// The defect: `Skill` (lib/skills/registry.ts) has no source/license field, so
// both seed paths (scripts/sync-skills.ts, app/api/skills/sync/route.ts)
// hardcoded `source: 'builtin'` and omitted `license` entirely — even though
// the real values already existed on `CatalogSkill` via getCombinedCatalog().
// Production ended up with 443 rows uniformly stamped source='harvest',
// license='MIT', including Apache-2.0 skills like harvested:ad-creative — a
// false licensing claim about third-party code.
//
// Fixing the seed's row builder alone is not enough: sync-skills.ts's
// `changed` comparison (now extracted as `rowChanged`) has to also compare
// source/license, or a row that already exists (wrong) never gets updated —
// the fix would be written but never read. That is the case these tests
// target.

import { describe, it, expect } from 'vitest';
import { getCatalogSourceLicense, getCombinedCatalog, ROUTABLE_SKILLS } from '@/lib/skills/registry';
import { desired, rowChanged, type Row } from '../scripts/sync-skills';

describe('getCatalogSourceLicense', () => {
  it('gives a harvested skill its real source and license, not a guess', () => {
    const { source, license } = getCatalogSourceLicense('harvested:ad-creative');
    expect(source).toBe('adclaw');
    expect(license).toBe('Apache-2.0');
  });

  it('gives a built-in "built-in" and NULL license, never a guessed license', () => {
    const { source, license } = getCatalogSourceLicense('skill-humanizer');
    expect(source).toBe('built-in');
    expect(license).toBeNull();
  });
});

describe('the seed row builder (scripts/sync-skills.ts desired())', () => {
  const rows = desired();
  const byId = new Map(rows.map((r) => [r.slug, r]));

  it('emits the catalog\'s real source/license for a harvested row', () => {
    const row = byId.get('harvested:ad-creative')!;
    expect(row).toBeTruthy();
    expect(row.source).toBe('adclaw');
    expect(row.license).toBe('Apache-2.0');
  });

  it('emits NULL license (not a string) for a built-in row', () => {
    const row = byId.get('skill-humanizer')!;
    expect(row).toBeTruthy();
    expect(row.source).toBe('built-in');
    expect(row.license).toBeNull();
  });

  it('never emits the old blanket "builtin"/"MIT" for a non-MIT, non-built-in skill', () => {
    // harvested:ad-creative is Apache-2.0 via adclaw — the exact row the
    // production defect mislabeled MIT/harvest.
    const row = byId.get('harvested:ad-creative')!;
    expect(row.source).not.toBe('builtin');
    expect(row.source).not.toBe('harvest');
    expect(row.license).not.toBe('MIT');
  });

  it('changes ONLY source/license relative to the catalog — every other column is untouched', () => {
    // Field-equivalence check: instructions/description/category/name must be
    // byte-identical to what ROUTABLE_SKILLS already produced, and inspired_by
    // must stay the ROUTABLE_SKILLS (coarse) string, NOT the more precise
    // CatalogSkill.inspiredBy — switching that would silently rewrite
    // inspired_by for all 668 harvested rows, which is out of scope here.
    const catalog = new Map(getCombinedCatalog().map((c) => [c.id, c]));
    const routable = new Map(ROUTABLE_SKILLS.map((s: any) => [s.id, s]));
    for (const row of rows) {
      const c = catalog.get(row.slug)!;
      const s = routable.get(row.slug)!;
      expect(row.instructions).toBe(c.instructions);
      expect(row.instructions).toBe(s.systemModule);
      expect(row.description).toBe(c.description);
      expect(row.category).toBe(c.category);
      expect(row.name).toBe(c.name);
      // inspired_by is deliberately NOT sourced from the catalog.
      expect(row.inspired_by).toBe(s.inspiredBy ?? null);
    }
  });
});

describe('rowChanged (the comparison that repairs an already-seeded row)', () => {
  const base: Row = {
    account_id: null,
    slug: 'harvested:ad-creative',
    name: 'ad-creative',
    category: 'ads',
    description: 'desc',
    instructions: 'do the thing',
    source: 'adclaw',
    license: 'Apache-2.0',
    inspired_by: 'Citedy/adclaw (Apache-2.0)',
  };

  it('flags a row whose stored source/license is wrong but whose content otherwise matches', () => {
    // This is production's actual shape before the fix: name/category/
    // description/instructions/inspired_by all correct, source/license wrong.
    const stored = { ...base, source: 'harvest', license: 'MIT' };
    expect(rowChanged(stored, base)).toBe(true);
  });

  it('flags a wrong license alone, even with a correct source', () => {
    const stored = { ...base, license: 'MIT' };
    expect(rowChanged(stored, base)).toBe(true);
  });

  it('flags a NULL stored license that should be a real license', () => {
    const stored = { ...base, license: null };
    expect(rowChanged(stored, base)).toBe(true);
  });

  it('does NOT flag a row that already matches exactly (steady state)', () => {
    const stored = { ...base };
    expect(rowChanged(stored, base)).toBe(false);
  });

  it('still flags unrelated content drift (content bug stays caught)', () => {
    const stored = { ...base, instructions: 'stale instructions' };
    expect(rowChanged(stored, base)).toBe(true);
  });
});

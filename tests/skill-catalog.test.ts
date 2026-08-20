// tests/skill-catalog.test.ts — the marketing skill catalog stays browsable.
//
// 341 of the 353 routable skills are harvested from four OSS marketing repos,
// and the harvester classifies each one from upstream frontmatter into ten
// disciplines: seo, content, ads, analytics, social, email, marketing, ops,
// dev-tooling, other.
//
// All of that was being thrown away on the way in. SkillCategory listed only
// the six names the twelve CURATED built-ins use, and the projection collapsed
// anything unrecognised to 'marketing' — so 343 of 353 rows in the skills table
// read 'marketing'. The category filter on the Skills page then offered a
// choice that returned 97% of the catalog, which is the same as offering no
// filter at all. Nothing failed; the feature just quietly did nothing.
//
// These tests assert the property that was violated rather than the specific
// list, so they keep holding as skills are added or re-harvested.

import { describe, it, expect } from 'vitest';
import { ROUTABLE_SKILLS, SKILL_CATEGORIES, type SkillCategory } from '@/lib/skills/registry';

const skills = ROUTABLE_SKILLS as { id: string; name: string; category: SkillCategory }[];
const counts = skills.reduce<Record<string, number>>((acc, s) => {
  acc[s.category] = (acc[s.category] || 0) + 1;
  return acc;
}, {});

describe('the catalog is real', () => {
  it('carries the built-ins plus the harvest', () => {
    expect(skills.length).toBeGreaterThan(300);
  });

  it('every skill has a category', () => {
    for (const s of skills) expect(s.category).toBeTruthy();
  });
});

describe('categories actually divide the catalog', () => {
  it('no single category swallows the majority of it', () => {
    // The bug: 'marketing' held 343 of 353. A filter that returns nearly
    // everything is not a filter, and this is the assertion that notices —
    // widening the union without also removing the collapse would still fail.
    const [biggest, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    expect(n / skills.length, `"${biggest}" holds ${n}/${skills.length}`).toBeLessThan(0.5);
  });

  it('the harvest\'s disciplines survive the projection', () => {
    // Each of these is a real bucket in lib/skills/harvested.ts. If the
    // projection stops recognising them they collapse into the fallback again,
    // silently, exactly as before.
    for (const c of ['seo', 'content', 'ads', 'analytics', 'social', 'email'] as const) {
      expect(counts[c] ?? 0, `no skills landed in "${c}"`).toBeGreaterThan(0);
    }
  });

  it('leaves the catalog usefully spread', () => {
    expect(Object.keys(counts).length).toBeGreaterThanOrEqual(8);
  });
});

describe('every category the catalog uses is one the UI can show', () => {
  it('has a label, so the filter can offer it', () => {
    // Skills.tsx builds its filter from the categories present on the rows. A
    // category with no entry in SKILL_CATEGORIES is a bucket the operator can
    // land in but never deliberately choose.
    const labelled = new Set(SKILL_CATEGORIES.map((c) => c.key as string));
    const used = Object.keys(counts);
    expect(used.filter((c) => !labelled.has(c))).toEqual([]);
  });

  it('declares no label twice', () => {
    const keys = SKILL_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('an unknown category degrades honestly', () => {
  it('falls back to "other", never to a real discipline', () => {
    // Defaulting an unknown into 'marketing' put skills in front of someone
    // browsing marketing and pushed out what genuinely belonged there. 'other'
    // claims nothing. Asserted structurally: 'other' must be an admitted
    // category, and must not be the biggest one.
    expect(SKILL_CATEGORIES.map((c) => c.key)).toContain('other');
    const biggest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    expect(biggest).not.toBe('other');
  });
});

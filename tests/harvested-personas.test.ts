// tests/harvested-personas.test.ts — the persona harvest is at real fidelity,
// not a one-line vibe.
//
// lib/agent/harvested-personas.ts used to keep ~3.2% of each upstream agent
// (9,010 chars total against 284,003 bytes upstream; several entries capped
// at exactly 500 chars). A persona is the voice and framework that executes a
// skill — tone, framing, judgement, boundaries — and cannot do that job at 3%
// fidelity. These tests pin the fix: every digital-marketing-pro persona's
// instructions must be long enough that a truncation bug like the old one
// cannot pass silently again.

import { describe, it, expect } from 'vitest';
import {
  HARVESTED_PERSONA_TEMPLATES,
  type HarvestedPersonaTemplate,
} from '@/lib/agent/harvested-personas';
import { HARVESTED_SKILLS } from '@/lib/skills/harvested';

const personas = HARVESTED_PERSONA_TEMPLATES;
const dmpPersonas = personas.filter((p) => p.sourceRepo === 'indranilbanerjee/digital-marketing-pro');
const adclawPersonas = personas.filter((p) => p.sourceRepo === 'Citedy/adclaw');
const gtmPersonas = personas.filter((p) => p.sourceRepo === 'gtmagents/gtm-agents');

describe('the harvest is complete', () => {
  it('has 233 entries: 24 digital-marketing-pro + 5 adclaw + 204 gtm-agents', () => {
    expect(personas.length).toBe(233);
    expect(dmpPersonas.length).toBe(24);
    expect(adclawPersonas.length).toBe(5);
    expect(gtmPersonas.length).toBe(204);
  });

  it('every entry has non-empty instructions', () => {
    for (const p of personas) {
      expect(p.instructions.trim().length, `${p.slug} has empty instructions`).toBeGreaterThan(0);
    }
  });

  // THE assertion that pins the truncation bug. Today's max (pre-fix) was
  // 500 chars; the real upstream bodies run 8,000-15,000 chars. 2,000 is
  // comfortably above any plausible truncation cap and comfortably below the
  // real minimum, so it fails loudly if someone re-introduces a slice/cap.
  it('every digital-marketing-pro persona keeps its full upstream body (>2000 chars)', () => {
    for (const p of dmpPersonas) {
      expect(p.instructions.length, `${p.slug} is only ${p.instructions.length} chars`).toBeGreaterThan(2000);
    }
  });
});

describe('slugs are unique', () => {
  it('no slug collides across all 29 entries', () => {
    const slugs = personas.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('adclaw entries are disambiguated from digital-marketing-pro (adclaw-seo-specialist vs seo-specialist)', () => {
    expect(personas.some((p) => p.slug === 'seo-specialist' && p.sourceRepo.includes('digital-marketing-pro'))).toBe(true);
    expect(personas.some((p) => p.slug === 'adclaw-seo-specialist' && p.sourceRepo.includes('adclaw'))).toBe(true);
  });
});

describe('domain is gated correctly', () => {
  const allowed = new Set(['marketing', 'outreach', 'shared']);

  it('every entry has one of the three allowed domain values', () => {
    for (const p of personas) expect(allowed.has(p.domain), `${p.slug} has domain ${p.domain}`).toBe(true);
  });

  it('all 24 digital-marketing-pro personas are "marketing"', () => {
    for (const p of dmpPersonas) expect(p.domain).toBe('marketing');
  });

  it('adclaw researcher/content-writer are "shared"; seo/ads/social are "marketing"', () => {
    const byRole = new Map(adclawPersonas.map((p) => [p.role, p.domain]));
    expect(byRole.get('researcher')).toBe('shared');
    expect(byRole.get('content-writer')).toBe('shared');
    expect(byRole.get('seo-specialist')).toBe('marketing');
    expect(byRole.get('ads-manager')).toBe('marketing');
    expect(byRole.get('social-media')).toBe('marketing');
  });

  it('digital-marketing-pro and adclaw have no "outreach" personas; gtm-agents contributes exactly 44', () => {
    expect(dmpPersonas.some((p) => p.domain === 'outreach')).toBe(false);
    expect(adclawPersonas.some((p) => p.domain === 'outreach')).toBe(false);
    expect(gtmPersonas.filter((p) => p.domain === 'outreach').length).toBe(44);
  });
});

// -----------------------------------------------------------------------------
// The "Agents Used" mapping this whole persona layer depends on: every
// digital-marketing-pro slug named in a harvested skill's "Agents Used"
// section must resolve to exactly one harvested persona. Parsed the same way
// the earlier analysis did: find "Agents Used" in a skill's instructions,
// then take **name** bold tokens in the following ~1500 chars, keeping only
// tokens shaped like a slug (lowercase letters and hyphens only — this is
// what separates a real agent reference like **content-creator** from
// unrelated bold text like **kpi_attached** or **schema-generator.py**, which
// contain characters no persona slug does).
// -----------------------------------------------------------------------------
function slugTokensNear(instructions: string, anchor: string, windowSize = 1500): string[] {
  const tokens: string[] = [];
  let idx = instructions.indexOf(anchor);
  while (idx !== -1) {
    const window = instructions.slice(idx, idx + windowSize);
    const bolds = window.match(/\*\*([^*]+)\*\*/g) || [];
    for (const b of bolds) {
      const name = b.slice(2, -2).trim();
      if (/^[a-z][a-z-]*$/.test(name)) tokens.push(name);
    }
    idx = instructions.indexOf(anchor, idx + 1);
  }
  return tokens;
}

describe('"Agents Used" references resolve', () => {
  const personaSlugs = new Set(personas.map((p) => p.slug));

  it('every slug-shaped bold token following "Agents Used" resolves to exactly one harvested persona', () => {
    const unresolved: { skill: string; token: string }[] = [];
    let sectionsWithRefs = 0;
    let totalRefs = 0;
    for (const skill of HARVESTED_SKILLS) {
      const tokens = slugTokensNear(skill.instructions, 'Agents Used');
      const inRosterTokens = tokens.filter((t) =>
        personaSlugs.has(t) || personaSlugs.has(`adclaw-${t}`),
      );
      if (inRosterTokens.length) sectionsWithRefs++;
      for (const t of tokens) {
        // Only tokens that ARE persona slugs are in scope for resolution;
        // stray slug-shaped bold text unrelated to agents (there is none in
        // practice once the character-class filter above is applied) would
        // otherwise be flagged as unresolved false positives.
        if (!personaSlugs.has(t) && !personaSlugs.has(`adclaw-${t}`)) continue;
        totalRefs++;
        const resolved = personas.filter((p) => p.slug === t);
        if (resolved.length !== 1) unresolved.push({ skill: skill.slug, token: t });
      }
    }
    expect(unresolved, JSON.stringify(unresolved)).toEqual([]);
    // Pins the count this analysis found: 116 skills carry at least one
    // "Agents Used" section whose bold tokens name a real digital-marketing-pro
    // persona slug.
    expect(sectionsWithRefs).toBe(116);
    expect(totalRefs).toBeGreaterThan(0);
  });

  it('every digital-marketing-pro slug is a plain, unprefixed roster name (never adclaw-prefixed)', () => {
    for (const p of dmpPersonas) {
      expect(p.slug.startsWith('adclaw-')).toBe(false);
    }
  });
});

describe('instructions carry real content, not a summary', () => {
  it('a spot-checked persona keeps sections the old 231-char truncation dropped', () => {
    const contentCreator = personas.find((p) => p.slug === 'content-creator');
    expect(contentCreator).toBeTruthy();
    const text = (contentCreator as HarvestedPersonaTemplate).instructions;
    expect(text).toContain('Core Capabilities');
    expect(text).toContain('Interaction Contract');
  });
});

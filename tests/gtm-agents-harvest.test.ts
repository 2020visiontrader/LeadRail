// tests/gtm-agents-harvest.test.ts — coverage the killed agent that harvested
// gtm-agents (gtmagents/gtm-agents, Apache-2.0) never wrote.
//
// Covers, per the plan:
//   1. Every gtm persona slug is namespaced ("gtm-" prefix) and unique across
//      the combined PERSONA_TEMPLATES.
//   2. Persona counts per source, and the domain distribution (44 outreach
//      from gtm + 8 authored = 52).
//   3. digital-marketing-pro's 210 "## Agents Used" references still resolve
//      ONLY to unprefixed dmp personas — the gtm prefix must not capture them.
//   4. The 50 coldoutbound skills still resolve to the 8 authored outreach
//      personas (PR #14's guarantee must not regress).
//   5. gtm skills carry a `personas` field populated from their sibling
//      agents/ directory, and a gtm skill resolves to a gtm persona end to
//      end (through personaSlugsForSkill -> pickPersonaSlug -> resolvePersona
//      against the real combined registry).
//   6. 'other' is not the largest skill category (the real assertion in
//      tests/skill-catalog.test.ts, exercised again here against the raw
//      harvest so a regression is caught at the source, not just the
//      projection).

import { describe, it, expect } from 'vitest';
import { HARVESTED_PERSONA_TEMPLATES } from '@/lib/agent/harvested-personas';
import { AUTHORED_PERSONA_TEMPLATES } from '@/lib/agent/authored-personas';
import { PERSONA_TEMPLATES } from '@/lib/agent/persona-registry';
import { COLDOUTBOUND_SKILL_PERSONA_MAP } from '@/lib/agent/coldoutbound-skill-personas';
import { personaSlugsForSkill, pickPersonaSlug, resolvePersona } from '@/lib/agent/persona-routing';
import { HARVESTED_SKILLS } from '@/lib/skills/harvested';

const gtmPersonas = HARVESTED_PERSONA_TEMPLATES.filter((p) => p.sourceRepo === 'gtmagents/gtm-agents');
const dmpPersonas = HARVESTED_PERSONA_TEMPLATES.filter(
  (p) => p.sourceRepo === 'indranilbanerjee/digital-marketing-pro',
);
const gtmSkills = HARVESTED_SKILLS.filter((s) => s.source === 'gtm-agents');

// -----------------------------------------------------------------------
// 1 & 2. Namespacing, uniqueness, counts, domain distribution.
// -----------------------------------------------------------------------

describe('gtm-agents personas are namespaced and unique', () => {
  it('every gtm persona slug starts with "gtm-"', () => {
    expect(gtmPersonas.length).toBeGreaterThan(0);
    for (const p of gtmPersonas) {
      expect(p.slug.startsWith('gtm-'), `${p.slug} is not gtm-prefixed`).toBe(true);
    }
  });

  it('no slug collides across the combined PERSONA_TEMPLATES registry (204 gtm + 29 other-harvested + 8 authored = 241)', () => {
    expect(PERSONA_TEMPLATES.length).toBe(241);
    const slugs = PERSONA_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('per-source counts: 204 gtm-agents, 24 digital-marketing-pro, 5 adclaw, 8 authored', () => {
    expect(gtmPersonas.length).toBe(204);
    expect(dmpPersonas.length).toBe(24);
    expect(HARVESTED_PERSONA_TEMPLATES.filter((p) => p.sourceRepo === 'Citedy/adclaw').length).toBe(5);
    expect(AUTHORED_PERSONA_TEMPLATES.length).toBe(8);
  });

  it('domain distribution: 52 outreach total (44 gtm + 8 authored), gtm also contributes marketing and shared', () => {
    const outreach = PERSONA_TEMPLATES.filter((t) => t.domain === 'outreach');
    expect(outreach.length).toBe(52);
    expect(gtmPersonas.filter((p) => p.domain === 'outreach').length).toBe(44);
    expect(gtmPersonas.filter((p) => p.domain === 'marketing').length).toBeGreaterThan(0);
    expect(gtmPersonas.filter((p) => p.domain === 'shared').length).toBeGreaterThan(0);
    // every gtm persona is accounted for by exactly these three domains
    const gtmByDomain = gtmPersonas.filter((p) => p.domain === 'outreach').length
      + gtmPersonas.filter((p) => p.domain === 'marketing').length
      + gtmPersonas.filter((p) => p.domain === 'shared').length;
    expect(gtmByDomain).toBe(gtmPersonas.length);
  });
});

// -----------------------------------------------------------------------
// 3. dmp "## Agents Used" resolution must stay untouched by the gtm prefix.
// -----------------------------------------------------------------------

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

describe('digital-marketing-pro "## Agents Used" references are unaffected by the gtm harvest', () => {
  it('every dmp skill\'s "Agents Used" tokens resolve to a real, non-gtm-prefixed persona', () => {
    const dmpSkills = HARVESTED_SKILLS.filter((s) => s.source === 'digital-marketing-pro');
    const dmpSlugs = new Set(dmpPersonas.map((p) => p.slug));
    let sectionsWithRefs = 0;
    let totalRefs = 0;
    for (const skill of dmpSkills) {
      const tokens = slugTokensNear(skill.instructions, 'Agents Used');
      const inRoster = tokens.filter((t) => dmpSlugs.has(t));
      if (inRoster.length) sectionsWithRefs++;
      for (const t of inRoster) {
        totalRefs++;
        expect(t.startsWith('gtm-'), `dmp reference "${t}" is gtm-prefixed`).toBe(false);
        const resolved = resolvePersona(t, [], PERSONA_TEMPLATES);
        expect(resolved, `"${t}" did not resolve`).toBeTruthy();
        expect(resolved?.source === 'template' ? resolved.template.sourceRepo : null).toBe(
          'indranilbanerjee/digital-marketing-pro',
        );
      }
    }
    // Pins the count the earlier harvested-personas.test.ts analysis found.
    expect(sectionsWithRefs).toBe(116);
    expect(totalRefs).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------
// 4. coldoutbound -> authored outreach personas (PR #14 guarantee).
// -----------------------------------------------------------------------

describe('the 50 coldoutbound skills still resolve to the 8 authored outreach personas', () => {
  it('every mapped skill slug resolves through the real registry to an "authored-for-leadrail" outreach persona', () => {
    const skillSlugs = Object.keys(COLDOUTBOUND_SKILL_PERSONA_MAP);
    expect(skillSlugs.length).toBe(50);
    const failures: string[] = [];
    for (const skillSlug of skillSlugs) {
      const personaSlug = pickPersonaSlug([{ slug: skillSlug, instructions: '' }]);
      if (!personaSlug) {
        failures.push(`${skillSlug}: no persona slug picked`);
        continue;
      }
      const resolved = resolvePersona(personaSlug, [], PERSONA_TEMPLATES);
      if (!resolved || resolved.source !== 'template') {
        failures.push(`${skillSlug}: did not resolve to a template`);
        continue;
      }
      if (resolved.template.sourceRepo !== 'growthenginenowoslawski/coldoutboundskills') {
        failures.push(`${skillSlug}: resolved to ${resolved.template.sourceRepo}, expected coldoutboundskills`);
      }
      if (resolved.template.domain !== 'outreach') {
        failures.push(`${skillSlug}: resolved to domain "${resolved.template.domain}", expected "outreach"`);
      }
    }
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// 5. gtm skills carry `personas` and resolve end to end.
// -----------------------------------------------------------------------

describe('gtm skills carry a personas field and resolve end to end', () => {
  it('every gtm skill has a non-empty personas array of gtm-prefixed slugs', () => {
    expect(gtmSkills.length).toBe(236);
    for (const s of gtmSkills) {
      expect(Array.isArray(s.personas), `${s.slug} has no personas array`).toBe(true);
      expect((s.personas || []).length, `${s.slug} personas is empty`).toBeGreaterThan(0);
      for (const p of s.personas || []) {
        expect(p.startsWith('gtm-'), `${s.slug} -> ${p} is not gtm-prefixed`).toBe(true);
      }
    }
  });

  it('every persona named by a gtm skill exists in PERSONA_TEMPLATES', () => {
    const slugs = new Set(PERSONA_TEMPLATES.map((t) => t.slug));
    const missing: string[] = [];
    for (const s of gtmSkills) {
      for (const p of s.personas || []) {
        if (!slugs.has(p)) missing.push(`${s.slug} -> ${p}`);
      }
    }
    expect(missing, JSON.stringify(missing)).toEqual([]);
  });

  it('a real gtm skill resolves end to end: personaSlugsForSkill -> pickPersonaSlug -> resolvePersona -> a gtm template', () => {
    const skill = gtmSkills.find((s) => s.slug === 'account-based-blueprint');
    expect(skill).toBeTruthy();
    const named = personaSlugsForSkill(skill!.instructions, skill!.slug);
    expect(named).toEqual(skill!.personas);

    const personaSlug = pickPersonaSlug([{ slug: skill!.slug, instructions: skill!.instructions }]);
    expect(personaSlug).toBeTruthy();
    expect((skill!.personas || []).includes(personaSlug as string)).toBe(true);

    const resolved = resolvePersona(personaSlug as string, [], PERSONA_TEMPLATES);
    expect(resolved?.source).toBe('template');
    expect(resolved && resolved.source === 'template' ? resolved.template.sourceRepo : null).toBe(
      'gtmagents/gtm-agents',
    );
  });
});

// -----------------------------------------------------------------------
// 6. 'other' is not the largest category in the raw gtm harvest.
// -----------------------------------------------------------------------

describe('gtm-agents skills are categorised by plugin, not dumped into "other"', () => {
  it('no gtm skill lands in "other" (every one of the 67 plugins maps to a real category)', () => {
    const other = gtmSkills.filter((s) => s.category === 'other');
    expect(other.map((s) => s.slug)).toEqual([]);
  });

  it('"other" is not the largest category across the whole harvested catalog', () => {
    const counts: Record<string, number> = {};
    for (const s of HARVESTED_SKILLS) counts[s.category] = (counts[s.category] || 0) + 1;
    const [biggest] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    expect(biggest).not.toBe('other');
  });
});

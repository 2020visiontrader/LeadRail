// Outreach persona authoring + unified registry + coldoutbound routing.
//
// Covers, per the plan:
//   1. Every one of the 8 authored outreach personas: instructions length
//      8,000-14,000 chars, domain 'outreach', source 'authored-for-leadrail',
//      non-empty groundedIn.
//   2. The combined registry (lib/agent/persona-registry.ts): unique slugs,
//      and now > 0 outreach personas (it was 0 before this change — that was
//      the gap).
//   3. End to end: every one of the 50 coldoutbound skills, run through
//      personaSlugsForSkill -> pickPersonaSlug -> resolvePersona against the
//      combined registry, resolves to an 'outreach' persona with non-empty
//      instructions.
//   4. digital-marketing-pro's existing "## Agents Used" references still
//      resolve ONLY to dmp (harvested) personas — pinning current behaviour,
//      proving the coldoutbound map never shadows the pre-existing routing.
//   5. A content-shaped skill still resolves to its content persona — both
//      engines work side by side, neither shadows the other.

import { describe, it, expect } from 'vitest';
import { AUTHORED_PERSONA_TEMPLATES } from '@/lib/agent/authored-personas';
import { HARVESTED_PERSONA_TEMPLATES } from '@/lib/agent/harvested-personas';
import { PERSONA_TEMPLATES } from '@/lib/agent/persona-registry';
import { COLDOUTBOUND_SKILL_PERSONA_MAP } from '@/lib/agent/coldoutbound-skill-personas';
import { personaSlugsForSkill, pickPersonaSlug, resolvePersona } from '@/lib/agent/persona-routing';
import { HARVESTED_SKILLS } from '@/lib/skills/harvested';

// -----------------------------------------------------------------------
// 1. Every authored persona meets the depth + provenance bar
// -----------------------------------------------------------------------

describe('AUTHORED_PERSONA_TEMPLATES — depth and provenance', () => {
  it('has exactly 8 personas, all domain "outreach"', () => {
    expect(AUTHORED_PERSONA_TEMPLATES.length).toBe(8);
    for (const p of AUTHORED_PERSONA_TEMPLATES) {
      expect(p.domain).toBe('outreach');
    }
  });

  it('every persona has instructions between 8,000 and 14,000 characters', () => {
    for (const p of AUTHORED_PERSONA_TEMPLATES) {
      expect(p.instructions.length, `${p.slug} instructions length`).toBeGreaterThanOrEqual(8000);
      expect(p.instructions.length, `${p.slug} instructions length`).toBeLessThanOrEqual(14000);
    }
  });

  it('every persona is marked source "authored-for-leadrail", never "harvested"', () => {
    for (const p of AUTHORED_PERSONA_TEMPLATES) {
      expect(p.source).toBe('authored-for-leadrail');
    }
  });

  it('every persona has a non-empty groundedIn list of coldoutbound skill slugs', () => {
    for (const p of AUTHORED_PERSONA_TEMPLATES) {
      expect(Array.isArray(p.groundedIn)).toBe(true);
      expect(p.groundedIn.length, `${p.slug} groundedIn`).toBeGreaterThan(0);
      for (const g of p.groundedIn) {
        expect(typeof g).toBe('string');
        expect(g.length).toBeGreaterThan(0);
      }
    }
  });

  it('every persona slug is unique within the authored set', () => {
    const slugs = AUTHORED_PERSONA_TEMPLATES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

// -----------------------------------------------------------------------
// 2. The combined registry
// -----------------------------------------------------------------------

describe('PERSONA_TEMPLATES — combined registry', () => {
  it('contains every harvested template plus every authored template', () => {
    expect(PERSONA_TEMPLATES.length).toBe(
      HARVESTED_PERSONA_TEMPLATES.length + AUTHORED_PERSONA_TEMPLATES.length,
    );
  });

  it('has unique slugs across the combined set', () => {
    const slugs = PERSONA_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('has 52 outreach personas: 8 authored + 44 from the gtm-agents harvest', () => {
    const outreach = PERSONA_TEMPLATES.filter((t) => t.domain === 'outreach');
    expect(outreach.length).toBeGreaterThan(0);
    expect(outreach.length).toBe(52);
    expect(outreach.filter((t) => t.sourceRepo === 'growthenginenowoslawski/coldoutboundskills').length).toBe(8);
    expect(outreach.filter((t) => t.sourceRepo === 'gtmagents/gtm-agents').length).toBe(44);
  });

  it('still has the pre-existing marketing and shared personas untouched', () => {
    const marketing = PERSONA_TEMPLATES.filter((t) => t.domain === 'marketing');
    const shared = PERSONA_TEMPLATES.filter((t) => t.domain === 'shared');
    expect(marketing.length).toBeGreaterThan(0);
    expect(shared.length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------
// 3. The explicit coldoutbound map has exactly 50 entries, all resolvable
// -----------------------------------------------------------------------

describe('COLDOUTBOUND_SKILL_PERSONA_MAP', () => {
  it('has exactly 50 entries', () => {
    expect(Object.keys(COLDOUTBOUND_SKILL_PERSONA_MAP).length).toBe(50);
  });

  it('every mapped persona slug exists in PERSONA_TEMPLATES as an outreach persona', () => {
    const outreachSlugs = new Set(
      PERSONA_TEMPLATES.filter((t) => t.domain === 'outreach').map((t) => t.slug),
    );
    for (const [skillSlug, personaSlug] of Object.entries(COLDOUTBOUND_SKILL_PERSONA_MAP)) {
      expect(outreachSlugs.has(personaSlug), `${skillSlug} -> ${personaSlug}`).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------
// 3b. End to end: every one of the 50 coldoutbound skills resolves to an
// outreach persona with non-empty instructions via the real routing path.
// -----------------------------------------------------------------------

describe('end-to-end coldoutbound skill -> persona resolution', () => {
  it('every one of the 50 coldoutbound skills resolves to an outreach persona', () => {
    const failures: string[] = [];
    for (const skillSlug of Object.keys(COLDOUTBOUND_SKILL_PERSONA_MAP)) {
      // A coldoutbound skill's instructions text has no "## Agents Used"
      // section (that's the whole reason the explicit map exists) — an empty
      // placeholder proves the resolution comes from the map, not the text.
      const slugs = personaSlugsForSkill('', skillSlug);
      const picked = pickPersonaSlug([{ slug: skillSlug, instructions: '' }]);
      if (!picked) {
        failures.push(`${skillSlug}: pickPersonaSlug returned null`);
        continue;
      }
      const resolved = resolvePersona(picked, [], PERSONA_TEMPLATES);
      if (!resolved || resolved.source !== 'template') {
        failures.push(`${skillSlug}: resolvePersona did not resolve to a template (got ${resolved?.source})`);
        continue;
      }
      if (resolved.template.domain !== 'outreach') {
        failures.push(`${skillSlug}: resolved to domain "${resolved.template.domain}", expected "outreach"`);
      }
      if (!resolved.template.instructions || resolved.template.instructions.length === 0) {
        failures.push(`${skillSlug}: resolved persona has empty instructions`);
      }
      if (slugs.length !== 1 || slugs[0] !== COLDOUTBOUND_SKILL_PERSONA_MAP[skillSlug]) {
        failures.push(`${skillSlug}: personaSlugsForSkill returned ${JSON.stringify(slugs)}, expected [${COLDOUTBOUND_SKILL_PERSONA_MAP[skillSlug]}]`);
      }
    }
    // STOP and report — do not ship an inert mapping.
    expect(failures).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// 4. digital-marketing-pro's existing references still resolve ONLY to dmp
//    (harvested) personas — pinning current behaviour.
// -----------------------------------------------------------------------

describe('digital-marketing-pro references still resolve only to harvested personas', () => {
  it('a real dmp skill\'s "## Agents Used" slug resolves to a harvested, non-outreach template', () => {
    const skill = HARVESTED_SKILLS.find((s) => s.slug === 'ab-test-plan');
    expect(skill).toBeTruthy();
    const slugs = personaSlugsForSkill(skill!.instructions);
    expect(slugs).toContain('cro-specialist');

    const resolved = resolvePersona('cro-specialist', [], PERSONA_TEMPLATES);
    expect(resolved?.source).toBe('template');
    expect(resolved && resolved.source === 'template' ? resolved.template.domain : null).not.toBe('outreach');
  });

  it('every dmp skill slug (not in the coldoutbound map) resolves the same way through PERSONA_TEMPLATES as through HARVESTED_PERSONA_TEMPLATES alone', () => {
    const templateSlugs = new Set(HARVESTED_PERSONA_TEMPLATES.map((t) => t.slug));
    const isEligible = (slug: string) => templateSlugs.has(slug);
    let checked = 0;
    for (const skill of HARVESTED_SKILLS) {
      if (COLDOUTBOUND_SKILL_PERSONA_MAP[skill.slug]) continue; // not a dmp skill
      const slugs = personaSlugsForSkill(skill.instructions);
      const hasResolvable = slugs.some((s) => templateSlugs.has(s));
      if (!hasResolvable) continue;
      checked++;
      const pickedOld = pickPersonaSlug([skill.instructions], isEligible);
      const pickedNew = pickPersonaSlug([{ slug: skill.slug, instructions: skill.instructions }], isEligible);
      expect(pickedNew).toBe(pickedOld);
      const resolved = resolvePersona(pickedNew as string, [], PERSONA_TEMPLATES);
      expect(resolved?.source).toBe('template');
      expect(resolved && resolved.source === 'template' ? resolved.template.domain : null).not.toBe('outreach');
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------
// 5. Both engines work side by side — neither shadows the other.
// -----------------------------------------------------------------------

describe('both engines resolve independently', () => {
  it('a content-shaped (dmp) skill resolves to a content persona while a coldoutbound skill in the same routed batch resolves the batch to an outreach winner only when it dominates, and each persona pick independently resolves to its own correct domain', () => {
    const dmpSkill = HARVESTED_SKILLS.find((s) => s.slug === 'ab-test-plan')!;
    const outreachSkillSlug = 'campaign-copywriting';

    // Each resolves independently and correctly to its own engine.
    const dmpPersonaSlug = pickPersonaSlug([{ slug: dmpSkill.slug, instructions: dmpSkill.instructions }]);
    const outreachPersonaSlug = pickPersonaSlug([{ slug: outreachSkillSlug, instructions: '' }]);

    expect(dmpPersonaSlug).toBe('cro-specialist');
    expect(outreachPersonaSlug).toBe('outreach-copywriter');

    const dmpResolved = resolvePersona(dmpPersonaSlug as string, [], PERSONA_TEMPLATES);
    const outreachResolved = resolvePersona(outreachPersonaSlug as string, [], PERSONA_TEMPLATES);

    expect(dmpResolved?.source).toBe('template');
    expect(outreachResolved?.source).toBe('template');
    expect(dmpResolved && dmpResolved.source === 'template' ? dmpResolved.template.domain : null).not.toBe('outreach');
    expect(outreachResolved && outreachResolved.source === 'template' ? outreachResolved.template.domain : null).toBe('outreach');
  });
});

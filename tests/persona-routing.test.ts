// BACKLOG 5b — persona routing. A persona is the VOICE AND FRAMEWORK that
// executes a skill; these tests cover lib/agent/persona-routing.ts (pure,
// no DB imports) directly, plus the wiring into the agent loop and into
// createPlan (lib/capabilities/plans.ts) where the pin actually reaches
// prod code.

import { describe, it, expect } from 'vitest';
import {
  personaSlugsForSkill, normalizeRef, resolvePersona, pickPersonaSlug,
  type PersonaResolution,
} from '@/lib/agent/persona-routing';
import { HARVESTED_SKILLS } from '@/lib/skills/harvested';
import type { PersonaRow } from '@/lib/agent/personas';
import { HARVESTED_PERSONA_TEMPLATES, type HarvestedPersonaTemplate } from '@/lib/agent/harvested-personas';

// -----------------------------------------------------------------------
// personaSlugsForSkill
// -----------------------------------------------------------------------

describe('personaSlugsForSkill', () => {
  it('extracts the bold persona token(s) from a real skill\'s "## Agents Used" section', () => {
    const skill = HARVESTED_SKILLS.find((s) => s.slug === 'ab-test-plan');
    expect(skill).toBeTruthy();
    const slugs = personaSlugsForSkill(skill!.instructions);
    expect(slugs).toContain('cro-specialist');
  });

  it('returns [] for a real skill with no "Agents Used" section (an AdClaw skill)', () => {
    const skill = HARVESTED_SKILLS.find((s) => s.slug === 'ad-creative');
    expect(skill).toBeTruthy();
    expect(skill!.instructions).not.toContain('Agents Used');
    expect(personaSlugsForSkill(skill!.instructions)).toEqual([]);
  });

  it('dedupes and preserves order of first appearance', () => {
    const text = '## Agents Used\n\n- **seo-specialist** — a\n- **content-creator** — b\n- **seo-specialist** — repeated';
    expect(personaSlugsForSkill(text)).toEqual(['seo-specialist', 'content-creator']);
  });
});

// -----------------------------------------------------------------------
// normalizeRef
// -----------------------------------------------------------------------

describe('normalizeRef', () => {
  it('matches the AdClaw _normalize_ref cases', () => {
    expect(normalizeRef('Content Writer')).toBe('content-writer');
    expect(normalizeRef('SEO Specialist')).toBe('seo-specialist');
  });

  it('trims a trailing space on a hand-typed row name', () => {
    expect(normalizeRef('Content Writer ')).toBe('content-writer');
  });
});

// -----------------------------------------------------------------------
// resolvePersona precedence
// -----------------------------------------------------------------------

function row(overrides: Partial<PersonaRow> = {}): PersonaRow {
  return {
    id: 'row-1',
    account_id: 'acct-1',
    name: 'Content Writer',
    role: 'content-writer',
    instructions: 'row instructions',
    model_id: null,
    tone: null,
    avatar: null,
    is_coordinator: false,
    enabled: true,
    sort_order: 0,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function template(overrides: Partial<HarvestedPersonaTemplate> = {}): HarvestedPersonaTemplate {
  return {
    slug: 'content-writer',
    name: 'Content Writer',
    description: 'template desc',
    role: 'content-writer',
    instructions: 'template instructions',
    domain: 'shared',
    sourceRepo: 'indranilbanerjee/digital-marketing-pro',
    sourceCommit: 'abc',
    sourcePath: 'agents/content-writer.md',
    license: 'MIT',
    ...overrides,
  };
}

describe('resolvePersona precedence', () => {
  it('an enabled, non-coordinator DB row beats a template of the same slug', () => {
    const r = row();
    const t = template();
    const result = resolvePersona('content-writer', [r], [t]) as PersonaResolution;
    expect(result?.source).toBe('row');
    expect(result && result.source === 'row' && result.row.id).toBe('row-1');
  });

  it('falls back to the harvested template when no row matches', () => {
    const t = template();
    const result = resolvePersona('content-writer', [], [t]) as PersonaResolution;
    expect(result?.source).toBe('template');
    expect(result && result.source === 'template' && result.template.slug).toBe('content-writer');
  });

  it('a disabled row does not match — falls through to the template', () => {
    const r = row({ enabled: false });
    const t = template();
    const result = resolvePersona('content-writer', [r], [t]) as PersonaResolution;
    expect(result?.source).toBe('template');
  });

  it('a coordinator row does not match — falls through to the template', () => {
    const r = row({ is_coordinator: true });
    const t = template();
    const result = resolvePersona('content-writer', [r], [t]) as PersonaResolution;
    expect(result?.source).toBe('template');
  });

  it('returns null when neither a row nor a template names the slug', () => {
    expect(resolvePersona('nobody-home', [], [])).toBeNull();
  });

  it('matches a row by normalized name even when role is unset', () => {
    const r = row({ role: null, name: 'Content Writer' });
    const result = resolvePersona('content-writer', [r], []) as PersonaResolution;
    expect(result?.source).toBe('row');
  });
});

// -----------------------------------------------------------------------
// pickPersonaSlug — single-persona tie-break
// -----------------------------------------------------------------------

describe('pickPersonaSlug', () => {
  it('picks the slug named by the most routed skills', () => {
    const skills = [
      '## Agents Used\n\n- **seo-specialist** — a',
      '## Agents Used\n\n- **content-creator** — b',
      '## Agents Used\n\n- **content-creator** — c',
    ];
    expect(pickPersonaSlug(skills)).toBe('content-creator');
  });

  it('ties are broken by routing order (earliest-appearing slug wins)', () => {
    const skills = [
      '## Agents Used\n\n- **seo-specialist** — a',
      '## Agents Used\n\n- **content-creator** — b',
    ];
    expect(pickPersonaSlug(skills)).toBe('seo-specialist');
  });

  it('returns null when no routed skill names a persona', () => {
    expect(pickPersonaSlug(['no agents section here', 'nor here'])).toBeNull();
  });
});

// -----------------------------------------------------------------------
// pickPersonaSlug — eligibility predicate (persona-routing hardening:
// an unresolvable **bold** token, e.g. a script filename or checklist key
// caught by the "Agents Used" window parser, must not be able to win the
// count or the first-appearance tie-break; see BACKLOG 5b follow-up note).
// -----------------------------------------------------------------------

describe('pickPersonaSlug — eligibility predicate', () => {
  it('ignores an ineligible slug that would otherwise win on count', () => {
    const skills = [
      '## Agents Used\n\n- **junk-token** — a',
      '## Agents Used\n\n- **junk-token** — b',
      '## Agents Used\n\n- **seo-specialist** — c',
    ];
    // Without a predicate, junk-token wins on count (2 vs 1).
    expect(pickPersonaSlug(skills)).toBe('junk-token');
    // With a predicate that excludes it, seo-specialist wins instead.
    const isEligible = (slug: string) => slug !== 'junk-token';
    expect(pickPersonaSlug(skills, isEligible)).toBe('seo-specialist');
  });

  it('ignores an ineligible slug that would otherwise win the first-appearance tie-break', () => {
    // junk-token appears first, both slugs have count 1.
    const skills = [
      '## Agents Used\n\n- **junk-token** — a',
      '## Agents Used\n\n- **seo-specialist** — b',
    ];
    // Without a predicate, junk-token wins the tie-break (appeared first).
    expect(pickPersonaSlug(skills)).toBe('junk-token');
    // With a predicate that excludes it, seo-specialist is the only eligible
    // candidate and wins.
    const isEligible = (slug: string) => slug !== 'junk-token';
    expect(pickPersonaSlug(skills, isEligible)).toBe('seo-specialist');
  });

  it('behaves exactly as before when no predicate is supplied', () => {
    const skills = [
      '## Agents Used\n\n- **seo-specialist** — a',
      '## Agents Used\n\n- **content-creator** — b',
      '## Agents Used\n\n- **content-creator** — c',
    ];
    expect(pickPersonaSlug(skills)).toBe('content-creator');
    expect(pickPersonaSlug(skills, undefined)).toBe('content-creator');
  });
});

// -----------------------------------------------------------------------
// Real-data: over every harvested skill, picking WITH the eligibility
// predicate must always land on a slug that actually resolves.
// -----------------------------------------------------------------------

describe('pickPersonaSlug — real HARVESTED_SKILLS data with eligibility predicate', () => {
  it('for every skill whose "Agents Used" names at least one resolvable slug, the eligible pick always resolves', () => {
    const templateSlugs = new Set(HARVESTED_PERSONA_TEMPLATES.map((t) => t.slug));
    const isEligible = (slug: string) => templateSlugs.has(slug);

    let checked = 0;
    for (const skill of HARVESTED_SKILLS) {
      const slugs = personaSlugsForSkill(skill.instructions);
      const hasResolvable = slugs.some((s) => templateSlugs.has(s));
      if (!hasResolvable) continue;
      checked++;
      const picked = pickPersonaSlug([skill.instructions], isEligible);
      expect(picked).not.toBeNull();
      expect(templateSlugs.has(picked as string)).toBe(true);
    }
    // Sanity: the real-data corpus actually exercised this property.
    expect(checked).toBeGreaterThan(0);
  });
});

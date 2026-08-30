// Persona routing (BACKLOG 5b) — pure functions, no DB imports, so this
// module is directly unit-testable against real harvested skill text.
//
// A persona is the VOICE AND FRAMEWORK that executes a skill: tone, framing,
// judgement, boundaries (see lib/agent/harvested-personas.ts). This module
// answers two questions the agent loop needs each turn:
//   1. Which persona slug(s) does a routed skill's "## Agents Used" section
//      name? (personaSlugsForSkill)
//   2. Given a slug, which concrete voice wins — an account's own customised
//      DB row, or the harvested template? (resolvePersona)
// lib/agent/loop.ts is the only caller that turns this into a system-prompt
// block; this file has no opinion on prompts, DB rows beyond their shape, or
// the agent loop.

import type { PersonaRow } from './personas';
import type { HarvestedPersonaTemplate } from './harvested-personas';

// How far past the "Agents Used" heading to look for `**slug**` bold tokens.
// Generous enough to catch every persona in a multi-agent section (the
// longest observed section lists five), narrow enough that it does not
// reliably wander into an unrelated "## Scripts Used" section that follows
// in some skills — when it does, the stray tokens simply fail to resolve to
// any row or template and are dropped by resolvePersona/pickPersonaSlug.
const AGENTS_USED_WINDOW = 1500;

/**
 * Persona slugs a skill's instructions name in its "## Agents Used" section,
 * in order of first appearance, deduped. Returns [] when the skill has no
 * such section (true for every AdClaw skill and skills that predate the
 * convention).
 */
export function personaSlugsForSkill(instructions: string): string[] {
  const idx = instructions.indexOf('Agents Used');
  if (idx === -1) return [];
  const window = instructions.slice(idx, idx + AGENTS_USED_WINDOW);
  const matches = window.match(/\*\*([^*]+)\*\*/g) || [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of matches) {
    const token = raw.slice(2, -2).trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

/**
 * Normalize a user-facing persona reference for tolerant matching — a direct
 * port of AdClaw's PersonaManager._normalize_ref
 * (adclaw/src/adclaw/agents/persona_manager.py): lowercase, collapse any run
 * of non-alphanumerics to a single "-", strip leading/trailing "-".
 *   normalizeRef("Content Writer")   -> "content-writer"
 *   normalizeRef("SEO Specialist")   -> "seo-specialist"
 *   normalizeRef("Content Writer ")  -> "content-writer"
 */
export function normalizeRef(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type PersonaResolution =
  | { source: 'row'; row: PersonaRow }
  | { source: 'template'; template: HarvestedPersonaTemplate };

/**
 * Resolve one persona slug (as named in a skill's "Agents Used" section) to
 * the voice that should speak for it, in this precedence — the load-bearing
 * design decision:
 *   1. An ENABLED, non-coordinator DB row whose normalized `role` or `name`
 *      equals the slug. An account that customised a persona wins over the
 *      stock template — the row is what the account actually configured.
 *   2. The harvested template with that exact slug.
 *   3. null — nothing named it.
 * A disabled row or a coordinator row is never eligible: a coordinator is a
 * synthesis voice, not a skill's executing persona, and a disabled row is not
 * in play for anything.
 */
export function resolvePersona(
  slug: string,
  rows: PersonaRow[],
  templates: HarvestedPersonaTemplate[],
): PersonaResolution | null {
  const row = rows.find(
    (r) =>
      r.enabled &&
      !r.is_coordinator &&
      ((r.role && normalizeRef(r.role) === slug) || normalizeRef(r.name) === slug),
  );
  if (row) return { source: 'row', row };

  const template = templates.find((t) => t.slug === slug);
  if (template) return { source: 'template', template };

  return null;
}

/**
 * Choose AT MOST ONE persona slug to voice this turn, from the skills Hermes
 * routed for it. Multiple routed skills may name different personas — two
 * voices in one prompt is the stapled-persona failure CLAUDE.md warns about,
 * so exactly one wins: the slug named by the most routed skills (a skill
 * naming a slug counts once, however many times it repeats the bold token),
 * ties broken by the order the skills came back from routing (earliest
 * first-appearance wins). Returns null when no routed skill names a persona.
 *
 * `isEligible`, when supplied, filters which slugs can be counted or won at
 * all — a slug that fails it (e.g. a `**bold**` token in the "Agents Used"
 * window that is actually a script filename or checklist key, not a persona)
 * is dropped before counting, so it can never win the count or the
 * first-appearance tie-break, and the pick falls through to the next-best
 * eligible slug instead of giving up. Omit it to keep the original
 * behaviour (every bold token is eligible), which is what the pre-existing
 * pure-function tests pin.
 */
export function pickPersonaSlug(
  skillInstructions: string[],
  isEligible?: (slug: string) => boolean,
): string | null {
  const counts = new Map<string, number>();
  for (const instructions of skillInstructions) {
    const slugs = new Set(personaSlugsForSkill(instructions));
    for (const slug of slugs) {
      if (isEligible && !isEligible(slug)) continue;
      counts.set(slug, (counts.get(slug) || 0) + 1);
    }
  }
  // Map preserves insertion order, which is first-appearance order across
  // `skillInstructions` (already in routing order) — so a strict ">" here,
  // scanning in that order, both picks the max count AND resolves ties to
  // whichever slug appeared first. No separate tie-break bookkeeping needed.
  let best: string | null = null;
  let bestCount = 0;
  for (const [slug, count] of counts) {
    if (count > bestCount) {
      best = slug;
      bestCount = count;
    }
  }
  return best;
}

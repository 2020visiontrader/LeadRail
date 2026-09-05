// Bridge between the skills library and the generation layer.
//
// selectSkillsForTurn (lib/agent/loop.ts) already routes an account's enabled
// skills into every CHAT turn's system prompt. It does nothing for content or
// image GENERATION: generateContentPost (lib/ai/generation.ts) and
// generateBrandImage (lib/capabilities/content.ts) build a fixed prompt
// (marketingGuidance + a bare niche string) that never consults the library,
// so an account with hundreds of enabled skills gets none of that guidance in
// the artifact it actually produces. This is the missing call.
//
// Reuses the EXISTING machinery rather than re-implementing routing:
//   - loadEnabledSkillsForAgent (lib/skills/store.ts) — account-scoped, and
//     already passed through the content screen (lib/skills/security.ts)
//     before anything here sees it. Do not bypass that.
//   - hermesRoute (lib/ai/hermes.ts) — the same classifier the chat loop
//     uses, given a query built from the generation call's own facts
//     (kind + platform + topic + niche) instead of a chat message. That is a
//     BETTER routing signal than what selectSkillsForTurn gets in a plan-step
//     tick, since it names exactly what is being produced.
//
// PREFIX NOTE (do not "fix" this by stripping or adding a prefix): the global
// catalog seeds harvested skills with `slug = catalog.id = 'harvested:<slug>'`
// (lib/skills/registry.ts harvestedToCatalog, pushed to the DB by
// scripts/sync-skills.ts). loadEnabledSkillsForAgent's `slug` field is read
// straight off that DB column, so it already carries the `harvested:` prefix
// when present. hermesRoute's skillIds are validated against
// lib/skills/registry.ts's ROUTABLE_SKILLS, whose ids are built the same way
// (`harvested:${h.slug}`). Both sides are therefore already in the SAME
// (possibly-prefixed) form — the intersection below is a plain Set lookup on
// purpose. Matching a bare harvested slug against either of these would
// silently fail (no error, just an empty result) and look identical to "no
// relevant skill" for that account.
//
// Never fatal: any failure, timeout, or empty route returns '' and the caller
// proceeds exactly as it did before this existed.

import { loadEnabledSkillsForAgent, type EnabledSkillInstruction } from './store';
import { hermesRoute } from '@/lib/ai/hermes';

/** Hard ceiling on how many skills' guidance can reach one generation call.
 *  Lower than the chat loop's MAX_ROUTED_SKILLS (4) — a generation call
 *  produces ONE artifact (a post, an image prompt), not an ongoing
 *  conversation, so it needs a nudge in the right direction, not a stack of
 *  playbooks. */
export const GENERATION_MAX_SKILLS = 2;

/** Per-skill clip width. DELIBERATELY NOT IMPORTED from lib/agent/loop.ts's
 *  SKILL_PER_SKILL_CHAR_CAP (same value, 2000) even though CLAUDE.md's own
 *  brief for this packet asked to reuse that constant where it fits — it
 *  doesn't fit here without breaking the build. lib/capabilities/content.ts
 *  and creative.ts (which call skillGuidanceForGeneration) are two of the
 *  capability files lib/capabilities/registry.ts assembles into CAPABILITIES,
 *  which lib/agent/tools.ts iterates to build TOOLS, which lib/agent/loop.ts
 *  imports. Importing loop.ts FROM HERE closes that into a cycle
 *  (registry -> content.ts -> for-generation.ts -> loop.ts -> tools.ts ->
 *  registry), and the module that loses the race sees CAPABILITIES as
 *  undefined at evaluation time — `CAPABILITIES.map is not a function`,
 *  observed breaking 10 unrelated test files when this was tried. Keeping
 *  the same NUMBER as a plain local constant preserves "reuse the same
 *  spirit" without the cycle. */
const GENERATION_PER_SKILL_CHAR_CAP = 2000;

/** Total chars this module will ever inject into a generation system prompt.
 *  Budgeted for GENERATION_MAX_SKILLS skills at GENERATION_PER_SKILL_CHAR_CAP
 *  each — i.e. "up to two skills, each clipped about as tightly as the chat
 *  loop clips them." Smaller than the chat loop's SKILL_TOTAL_CHAR_BUDGET
 *  (8000, for up to 4 skills) because there are at most 2 candidates here. */
export const GENERATION_TOTAL_CHAR_BUDGET = GENERATION_PER_SKILL_CHAR_CAP * GENERATION_MAX_SKILLS;

export interface GenerationSkillQuery {
  /** What kind of thing is being generated — e.g. 'social post', 'ad copy',
   *  'content piece', 'brand image'. Free text; it only shapes the routing
   *  query. */
  kind: string;
  platform?: string;
  topic?: string;
  niche?: string;
}

/** Clip skill instructions into the shared generation guidance budget,
 *  cutting each entry no larger than SKILL_PER_SKILL_CHAR_CAP and stopping
 *  once the total budget runs out. Mirrors skillsBlock's shape (lib/agent/
 *  loop.ts) at a smaller scale rather than reusing it directly — that
 *  function's per-slug describeSkill truncation marker names a chat-only
 *  capability that has no meaning inside a generation prompt. */
function composeGenerationGuidance(skills: EnabledSkillInstruction[]): string {
  let budget = GENERATION_TOTAL_CHAR_BUDGET;
  const lines: string[] = [];
  for (const s of skills) {
    if (budget <= 0) break;
    const cap = Math.min(GENERATION_PER_SKILL_CHAR_CAP, budget);
    let text = s.instructions;
    if (text.length > cap) text = `${text.slice(0, Math.max(0, cap - 1))}…`;
    if (!text) continue;
    budget -= text.length;
    lines.push(`• ${s.name}: ${text}`);
  }
  return lines.join('\n');
}

/**
 * Route this account's enabled skills against a generation call's own facts
 * and return a short, capped guidance string — or '' when there is nothing
 * to add (no accountId, no enabled skills, nothing relevant, or any error).
 *
 * Callers splice the result into a SYSTEM prompt, clearly labeled as house
 * guidance to apply rather than content to reproduce (see generateContentPost
 * and generateBrandImage for the exact wording) — this function returns only
 * the raw guidance text, never prompt wording of its own.
 */
export async function skillGuidanceForGeneration(
  accountId: string | undefined | null,
  query: GenerationSkillQuery,
): Promise<string> {
  if (!accountId) return '';
  const text = [query.kind, query.platform, query.topic].filter(Boolean).join(' — ').trim();
  if (!text) return '';
  try {
    const enabled = await loadEnabledSkillsForAgent(accountId);
    if (!enabled.length) return '';
    const plan = await hermesRoute(text, {
      accountId,
      sectors: query.niche ? [query.niche] : undefined,
    });
    const wanted = new Set(plan.skillIds || []);
    const picked = enabled.filter((s) => wanted.has(s.slug)).slice(0, GENERATION_MAX_SKILLS);
    if (!picked.length) return '';
    return composeGenerationGuidance(picked);
  } catch {
    return '';
  }
}

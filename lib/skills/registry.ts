// Curated skills registry.
//
// The user asked to "pull open-source GitHub repos" for Claude/marketing/
// LinkedIn/outreach/lead-gen/humanizer skills. We deliberately do NOT vendor
// arbitrary repo code into a production CRM that holds the service-role key and
// customer lead data — that is a supply-chain liability. Instead each skill is
// a bounded prompt-module: the distilled *pattern* those OSS repos encode
// (role + method + guardrails), plus the Go model tier it runs best on. Hermes
// selects skills from this catalog per request; adding a skill = adding a typed
// entry here, reviewable in one diff.

import type { TaskKind } from '@/lib/ai/models';
import { HARVESTED_SKILLS, type HarvestedSkill } from './harvested';

export type SkillCategory =
  // --- the twelve curated built-ins ---
  | 'claude' // Anthropic "Agent Skills" style structured task modules
  | 'marketing'
  | 'linkedin'
  | 'outreach'
  | 'lead-gen'
  | 'humanizer'
  // --- the harvest's own vocabulary (Packet 5.1, 341 skills) ---
  //
  // These were missing, and the projection below collapsed anything it did not
  // recognise into 'marketing'. Since the harvest uses NONE of the six names
  // above for the bulk of its entries, that meant 341 skills sorted across ten
  // marketing disciplines arrived as one undifferentiated bucket: 343 of 353
  // rows in the skills table read 'marketing'. The catalog filter on the Skills
  // page then offered a category that returned almost everything, which is the
  // same as offering no filter at all.
  //
  // The harvester did the classification work per skill, from upstream
  // frontmatter. Widening the union keeps it instead of throwing it away.
  | 'seo'
  | 'content'
  | 'ads'
  | 'analytics'
  | 'social'
  | 'email'
  | 'ops'
  | 'dev-tooling'
  | 'other';

export interface Skill {
  id: string;
  name: string;
  category: SkillCategory;
  // One-liner Hermes reads to decide relevance to a user request.
  when: string;
  // System-prompt fragment injected when the skill is active.
  systemModule: string;
  // Which task kind this skill's work is (drives model selection).
  taskKind: TaskKind;
  // Provenance note: the OSS pattern this module distills (for the audit trail).
  inspiredBy: string;
}

export const SKILLS: Skill[] = [
  // ---- claude / agent-skill format --------------------------------------
  {
    id: 'skill-structured-task',
    name: 'Structured Task Runner',
    category: 'claude',
    when: 'the request is a multi-part task that benefits from a checklist + explicit output contract',
    systemModule:
      'Operate as an Agent-Skill: restate the goal in one line, work in explicit numbered steps, and end with the exact output format requested. No preamble, no meta-commentary.',
    taskKind: 'reason',
    inspiredBy: 'anthropics/skills agent-skill spec (SKILL.md role+method+format shape)',
  },
  {
    id: 'skill-grounded-facts',
    name: 'Grounded Claims Guard',
    category: 'claude',
    when: 'output must not invent stats, case studies, or company facts',
    systemModule:
      'Only state facts present in the provided context (deck summary, knowledge, contact fields). If a claim is not supported, omit it or use a neutral placeholder — never fabricate numbers, logos, or testimonials.',
    taskKind: 'draft',
    inspiredBy: 'RAG grounding / "no-hallucination" system-prompt patterns',
  },

  // ---- marketing ---------------------------------------------------------
  {
    id: 'skill-pas-copy',
    name: 'PAS Copywriter',
    category: 'marketing',
    when: 'writing persuasive short copy where a pain point can anchor the message',
    systemModule:
      'Use Problem–Agitate–Solve: name the reader’s specific pain, sharpen the cost of inaction in one line, then present the offer as the resolution. One CTA. No hype adjectives.',
    taskKind: 'draft',
    inspiredBy: 'open copywriting-framework prompt collections (PAS/AIDA/BAB)',
  },
  {
    id: 'skill-value-prop',
    name: 'Value-Prop Distiller',
    category: 'marketing',
    when: 'a deck or description needs compressing into a crisp positioning line',
    systemModule:
      'Distill to: for [audience] who [need], [venture] is a [category] that [key benefit], unlike [alternative]. Concrete nouns, no buzzwords.',
    taskKind: 'extract',
    inspiredBy: 'Geoffrey Moore positioning template, widely mirrored in OSS prompt packs',
  },

  // ---- linkedin ----------------------------------------------------------
  {
    id: 'skill-linkedin-connect',
    name: 'LinkedIn Connector',
    category: 'linkedin',
    when: 'writing a LinkedIn connection note or first touch (<300 chars)',
    systemModule:
      'Write a LinkedIn connection note under 300 characters: one specific reason for reaching out tied to the recipient, zero pitch, warm and human. No "I came across your profile" filler.',
    taskKind: 'draft',
    inspiredBy: 'open LinkedIn-outreach prompt repos (short-note connection patterns)',
  },
  {
    id: 'skill-linkedin-dm',
    name: 'LinkedIn Value DM',
    category: 'linkedin',
    when: 'following up in LinkedIn DMs after a connection is accepted',
    systemModule:
      'Lead with a useful observation or resource relevant to the recipient before any ask. Conversational, 2-4 short lines, one soft CTA (a question, not a demo push).',
    taskKind: 'draft',
    inspiredBy: 'value-first social-selling DM frameworks',
  },

  // ---- outreach ----------------------------------------------------------
  {
    id: 'skill-cold-email',
    name: 'Cold Email Specialist',
    category: 'outreach',
    when: 'writing a cold outbound email to a business contact',
    systemModule:
      'Under 120 words. Personalized first line tied to the recipient/company, one insight, exactly one ask. Subject under 60 chars, lowercase-casual, no clickbait. Plain text, no emojis.',
    taskKind: 'draft',
    inspiredBy: 'open cold-email frameworks (3-sentence / "one clear ask" patterns)',
  },
  {
    id: 'skill-breakup-email',
    name: 'Breakup / Re-engage',
    category: 'outreach',
    when: 'last-step sequence email or reviving a cold thread',
    systemModule:
      'Write a short, low-pressure breakup email: acknowledge the silence, restate the single benefit, give an easy out. Never guilt-trip. 2-3 lines.',
    taskKind: 'draft',
    inspiredBy: 'sequence "breakup email" step conventions',
  },
  {
    id: 'skill-intent-router',
    name: 'Message Intent Router',
    category: 'outreach',
    when: 'the outreach has a specific intent (book_call, share_asset, reply_bait, reengage)',
    systemModule:
      'Shape the CTA and subject to the stated intent: book_call → propose a concrete low-friction time ask; share_asset → tease the asset’s payoff and link it; reply_bait → end on a single easy question; reengage → reference prior context lightly.',
    taskKind: 'draft',
    inspiredBy: 'intent-conditioned outreach prompt patterns',
  },

  // ---- lead-gen ----------------------------------------------------------
  {
    id: 'skill-icp-builder',
    name: 'ICP Builder',
    category: 'lead-gen',
    when: 'translating a venture/goal/sector into concrete Apollo search filters',
    systemModule:
      'Map the venture goal + sectors to Apollo People-Search filters: pick titles + seniority tokens that match the buyer/investor/partner, expand sectors to industry keywords, keep the ICP tight enough to be high-signal. Never invent a location that was not implied.',
    taskKind: 'extract',
    inspiredBy: 'open lead-sourcing "ICP → boolean filter" prompt repos',
  },
  {
    id: 'skill-deck-profiler',
    name: 'Pitch-Deck Profiler',
    category: 'lead-gen',
    when: 'a pitch deck / doc has been uploaded and needs turning into a venture profile',
    systemModule:
      'From the deck text infer: what the venture does, who it sells to or raises from, the sector, and the ideal contact profile. Separate stated facts from inference. Output a tight profile, not a summary essay.',
    taskKind: 'extract',
    inspiredBy: 'document-to-structured-profile extraction patterns',
  },

  // ---- humanizer ---------------------------------------------------------
  {
    id: 'skill-humanizer',
    name: 'AI-Tell Humanizer',
    category: 'humanizer',
    when: 'any generated copy that will be sent to a real person',
    systemModule:
      'Strip AI tells: no "I hope this finds you well", no em-dash-heavy cadence, no "delighted/thrilled/excited to", no tricolon padding. Vary sentence length, use plain words, sound like one busy human wrote it fast.',
    taskKind: 'draft',
    inspiredBy: 'open "humanize AI text" rule lists',
  },
];

export const SKILL_CATEGORIES: { key: SkillCategory; label: string }[] = [
  { key: 'claude', label: 'Claude skills' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'seo', label: 'SEO' },
  { key: 'content', label: 'Content' },
  { key: 'ads', label: 'Ads' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'social', label: 'Social' },
  { key: 'email', label: 'Email' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'outreach', label: 'Outreach' },
  { key: 'lead-gen', label: 'Lead generation' },
  { key: 'humanizer', label: 'Humanizer' },
  { key: 'ops', label: 'Ops' },
  { key: 'dev-tooling', label: 'Dev tooling' },
  { key: 'other', label: 'Other' },
];

/** Every category the union admits, for validating an incoming value without
 *  restating the list a third time. */
const KNOWN_CATEGORIES = new Set<string>(SKILL_CATEGORIES.map((c) => c.key));

/**
 * The harvested OSS catalog (Packet 5.1, 341 skills) projected into the same
 * `Skill` shape the built-ins use, so Hermes can select them and
 * composeSkillGuidance can inject them.
 *
 * Before this, harvested skills existed only in `skillCatalog()` — the shape the
 * API/UI reads — and were absent from `skillById`. Hermes therefore never saw
 * them, and even if it had named one, `getSkill()` would have returned undefined
 * and the id would have been filtered out of the plan. They were harvested and
 * catalogued but genuinely unreachable.
 *
 * Ids are namespaced `harvested:<slug>` so a harvested skill can never collide
 * with, or silently shadow, a curated built-in.
 *
 * `taskKind` is 'draft' for all of them: these are marketing prompt modules
 * (copy, SEO, ads, content), and 'draft' is the tier that produces prose. That
 * is a deliberate default, not derived data — the upstream frontmatter has no
 * equivalent field, and guessing per skill would be inventing information.
 */
const HARVESTED_AS_SKILLS: Skill[] = HARVESTED_SKILLS.map((h) => ({
  id: `harvested:${h.slug}`,
  name: h.name,
  // 'other' — not 'marketing' — is the fallback for an unrecognised category.
  // Defaulting an unknown to a REAL discipline is a quiet lie: it puts the skill
  // in front of someone browsing that discipline and pushes out what belongs
  // there. 'other' says what is actually known, which is nothing.
  category: KNOWN_CATEGORIES.has(h.category) ? (h.category as SkillCategory) : 'other',
  when: h.description,
  systemModule: h.instructions,
  taskKind: 'draft' as TaskKind,
  inspiredBy: `${h.sourceRepo} (${h.license})`,
}));

/** Everything Hermes may route to: the curated built-ins plus the harvest.
 *  Built-ins come FIRST so a prefilter that truncates still keeps them. */
export const ROUTABLE_SKILLS: Skill[] = [...SKILLS, ...HARVESTED_AS_SKILLS];

const skillById = new Map(ROUTABLE_SKILLS.map((s) => [s.id, s]));

export function getSkill(id: string): Skill | undefined {
  return skillById.get(id);
}

export function getSkills(ids: string[] | undefined | null): Skill[] {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => skillById.get(id)).filter(Boolean) as Skill[];
}

/** Concatenate the active skills' system modules into one guidance block. */
export function composeSkillGuidance(ids: string[] | undefined | null): string {
  const skills = getSkills(ids);
  if (!skills.length) return '';
  return skills.map((s) => `• ${s.name}: ${s.systemModule}`).join('\n');
}

/**
 * Goal-driven skill selection for outreach generation.
 *
 * The compose "AI goal" box is the steering wheel: the plain-language goal tells
 * us what kind of message this is, so we attach the right skills instead of the
 * same two every time. Deterministic keyword routing (no extra LLM call) keeps
 * it cheap and predictable.
 *
 * Precedence:
 *   1. If the venture pinned explicit skills (skills !== ['auto']/empty), honor
 *      them verbatim — the user chose.
 *   2. Otherwise ('auto' or unset) infer from the goal text.
 *
 * Grounding + humanizing are ALWAYS on for anything sent to a real person.
 */
export function selectSkillsForGoal(goal: string, ventureSkills?: string[] | null): string[] {
  const pinned = (ventureSkills || []).filter((s) => s && s !== 'auto');
  const always = ['skill-grounded-facts', 'skill-humanizer'];
  if (pinned.length) {
    return Array.from(new Set([...pinned, ...always]));
  }

  const g = (goal || '').toLowerCase();
  const has = (...tokens: string[]) => tokens.some((t) => g.includes(t));
  const ids = new Set<string>(always);

  // Channel: LinkedIn overrides the email defaults.
  const isLinkedIn = has('linkedin', 'connection request', 'connect on', 'inmail');
  if (isLinkedIn) {
    ids.add(has('follow', 'dm', 'after connect', 'accepted') ? 'skill-linkedin-dm' : 'skill-linkedin-connect');
  } else {
    // Email is the default channel.
    if (has('follow up', 'follow-up', 're-engage', 'reengage', 'revive', 'no reply', 'no response', 'gone quiet', 'breakup', 'last try', 'bump')) {
      ids.add('skill-breakup-email');
    } else {
      ids.add('skill-cold-email');
      // Pain-led asks lean on PAS; otherwise value-prop framing.
      if (has('pain', 'problem', 'struggl', 'losing', 'waste', 'churn', 'drop-off', 'dropoff', 'bottleneck')) {
        ids.add('skill-pas-copy');
      } else {
        ids.add('skill-value-prop');
      }
    }
  }

  // Intent shaping when the goal names a concrete outcome.
  if (has('call', 'meeting', 'demo', 'intro', 'chat', 'book', 'calendar', 'time to talk', 'share', 'send', 'deck', 'one-pager', 'one pager', 'asset', 'resource', 'reply', 'question', 'thoughts')) {
    ids.add('skill-intent-router');
  }

  return Array.from(ids);
}

/**
 * Human-readable explanation of which skills a goal will activate, for the UI
 * ("Auto will use: Cold Email Specialist, Value-Prop Distiller, …"). Reflects
 * the same logic selectSkillsForGoal uses, so the preview never lies.
 */
export function explainSkillSelection(goal: string, ventureSkills?: string[] | null): { id: string; name: string }[] {
  return selectSkillsForGoal(goal, ventureSkills)
    .map((id) => skillById.get(id))
    .filter(Boolean)
    .map((s) => ({ id: (s as Skill).id, name: (s as Skill).name }));
}

// ---------------------------------------------------------------------------
// Combined catalog accessor (migration 025_skills.sql).
//
// The original 12 built-ins above (SKILLS) are UNCHANGED and keep powering
// outreach generation exactly as before (selectSkillsForGoal/composeSkillGuidance
// only ever look at SKILLS). This section adds a read-only, static view of the
// harvested OSS catalog (lib/skills/harvested.ts, 341 skills from four
// permissively-licensed upstreams — adclaw (Apache-2.0), digital-marketing-pro,
// kai-cmo-harness (MIT subtrees only) and marketing-os-starter (MIT); see the
// root NOTICE) in the same shape the DB `skills` table rows take, so API
// routes/UI can present "built-in + harvested + custom" as one browsable list
// without a DB round-trip for the static portion. The DB `skills`/`account_skills`
// tables are the source of truth for what's actually enabled per account; this
// export is just a convenient static fallback/seed list.
// ---------------------------------------------------------------------------

export interface CatalogSkill {
  /** Stable identifier. For built-ins this is the Skill.id; for harvested it's `harvested:<slug>`. */
  id: string;
  name: string;
  description: string;
  category: string;
  instructions: string;
  source: 'built-in' | string;
  license?: string;
  inspiredBy?: string;
}

function builtInToCatalog(s: Skill): CatalogSkill {
  return {
    id: s.id,
    name: s.name,
    description: s.when,
    category: s.category,
    instructions: s.systemModule,
    source: 'built-in',
    inspiredBy: s.inspiredBy,
  };
}

function harvestedToCatalog(s: HarvestedSkill): CatalogSkill {
  return {
    id: `harvested:${s.slug}`,
    name: s.name,
    description: s.description,
    category: s.category,
    instructions: s.instructions,
    source: s.source,
    license: s.license,
    inspiredBy: s.inspiredBy,
  };
}

/**
 * The full static catalog: the 12 built-ins first (unchanged, still the ones
 * consumed by selectSkillsForGoal/composeSkillGuidance), then the harvested
 * OSS skills. Does NOT include per-account custom skills — those live only in
 * the `skills` DB table (account_id NOT NULL) and are merged in by the API
 * route, not here.
 */
export function getCombinedCatalog(): CatalogSkill[] {
  return [...SKILLS.map(builtInToCatalog), ...HARVESTED_SKILLS.map(harvestedToCatalog)];
}

export { HARVESTED_SKILLS };
export type { HarvestedSkill };

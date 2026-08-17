// Hermes — the agentic router.
//
// "Hermes ingests the user request and decides which skills to use and which
// OpenCode Go LLM makes sense." This is that layer. Given a natural-language
// request (+ optional venture context), Hermes returns a plan:
//   { intent, skillIds[], model, taskKind, rationale }
// which downstream generators consume: skills → system guidance, model →
// per-call OpenCode override.
//
// It uses a cheap, fast classify call (the fast Go tier) to pick from the
// registry, and ALWAYS falls back to a deterministic keyword router so a
// missing key / upstream error still yields a usable plan.

import { generateText, textConfigured } from './router';
import { pickModel, getModel, type TaskKind } from './models';
import { SKILLS, ROUTABLE_SKILLS, getSkill, type Skill } from '@/lib/skills/registry';

// Harvested-only slice, precomputed once: the built-ins are always in the
// shortlist, so scoring them again would be wasted work on every request.
const HARVESTED_FOR_ROUTING: Skill[] = ROUTABLE_SKILLS.slice(SKILLS.length);

export interface HermesPlan {
  intent: string;
  taskKind: TaskKind;
  skillIds: string[];
  model: string;
  modelLabel: string;
  rationale: string;
  source: 'ai' | 'fallback';
}

export interface HermesContext {
  ventureName?: string;
  leadGoal?: string;
  sectors?: string[];
}

// Deterministic intent → (taskKind, seed skills) map. Also the fallback brain.
const INTENTS: { intent: string; taskKind: TaskKind; match: RegExp; skills: string[] }[] = [
  {
    intent: 'source_leads',
    taskKind: 'extract',
    match: /\b(find|source|pull|search|prospect)\b.*\b(lead|contact|investor|customer|buyer|people)\b|apollo|icp/i,
    skills: ['skill-icp-builder', 'skill-grounded-facts'],
  },
  {
    intent: 'profile_deck',
    taskKind: 'extract',
    match: /\b(deck|pitch|one-?pager|document|pdf|pptx|slides)\b/i,
    skills: ['skill-deck-profiler', 'skill-value-prop', 'skill-grounded-facts'],
  },
  {
    intent: 'cold_email',
    taskKind: 'draft',
    match: /\b(cold )?email|outreach|reach out|write to|message the?m\b/i,
    skills: ['skill-cold-email', 'skill-intent-router', 'skill-humanizer'],
  },
  {
    intent: 'linkedin',
    taskKind: 'draft',
    match: /\blinkedin|connection (note|request)|\bdm\b/i,
    skills: ['skill-linkedin-connect', 'skill-linkedin-dm', 'skill-humanizer'],
  },
  {
    intent: 'sequence',
    taskKind: 'reason',
    match: /\bsequence|cadence|follow-?up|drip|multi-?step\b/i,
    skills: ['skill-structured-task', 'skill-cold-email', 'skill-breakup-email', 'skill-humanizer'],
  },
  {
    intent: 'marketing_copy',
    taskKind: 'draft',
    match: /\b(copy|headline|landing|ad|post|caption|social|content)\b/i,
    skills: ['skill-pas-copy', 'skill-value-prop', 'skill-humanizer'],
  },
];

function deterministicPlan(request: string): { intent: string; taskKind: TaskKind; skillIds: string[] } {
  const hit = INTENTS.find((i) => i.match.test(request));
  if (hit) return { intent: hit.intent, taskKind: hit.taskKind, skillIds: hit.skills };
  // Unknown → a safe general drafting posture.
  return { intent: 'general', taskKind: 'draft', skillIds: ['skill-structured-task', 'skill-humanizer'] };
}

function finalize(
  intent: string,
  taskKind: TaskKind,
  skillIds: string[],
  rationale: string,
  source: 'ai' | 'fallback',
): HermesPlan {
  const valid = skillIds.filter((id) => getSkill(id));
  const model = pickModel(taskKind);
  return {
    intent,
    taskKind,
    skillIds: valid.length ? valid : ['skill-structured-task'],
    model,
    modelLabel: getModel(model)?.label || model,
    rationale,
    source,
  };
}

/** How many skills the routing prompt may name. Keeps the classify call small
 *  and the choice discriminable. Built-ins are always included, so this is a
 *  floor of 12 plus the best-scoring harvested matches. */
const ROUTING_SHORTLIST = 45;

/** Words too common to carry signal — scoring on them would rank by noise. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'your',
  'you', 'our', 'are', 'was', 'can', 'how', 'what', 'why', 'who', 'when', 'get',
  'make', 'need', 'want', 'please', 'help', 'some', 'more', 'all', 'any',
]);

/**
 * Deterministic, offline prefilter: score every routable skill by term overlap
 * with the request, and return the built-ins plus the best harvested matches.
 *
 * Deliberately dumb — no embeddings, no model call. It runs before the routing
 * model on every request, so it must be free and instant. It does not decide
 * anything; it only decides what the model is allowed to SEE, and the model
 * still picks 1-4 from that. A poor shortlist degrades to the built-in 12,
 * which is exactly the behaviour before the harvest — never worse.
 */
/** One line's worth of "what is this skill for", flattened and bounded. The
 *  built-ins' `when` values are already one-liners and pass through untouched. */
function clipWhen(when: string, max = 150): string {
  const flat = String(when || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function shortlistForRouting(request: string): Skill[] {
  const terms = String(request || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  if (!terms.length) return SKILLS;

  const scored = HARVESTED_FOR_ROUTING.map((s) => {
    const hay = `${s.name} ${s.when} ${s.category}`.toLowerCase();
    // Count distinct matching terms, not occurrences: a skill that mentions
    // "email" ten times is not more relevant than one matching "email" AND
    // "sequence".
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score++;
    return { s, score };
  }).filter((x) => x.score > 0);

  scored.sort((a, b) => b.score - a.score);
  const room = Math.max(0, ROUTING_SHORTLIST - SKILLS.length);
  return [...SKILLS, ...scored.slice(0, room).map((x) => x.s)];
}

/**
 * Route a request to a plan. Tries a fast AI classification against the skill
 * catalog; on any problem falls back to the deterministic keyword router.
 */
export async function hermesRoute(request: string, ctx: HermesContext = {}): Promise<HermesPlan> {
  const text = String(request || '').trim();
  const base = deterministicPlan(text);  if (!textConfigured() || !text) {
    return finalize(base.intent, base.taskKind, base.skillIds, 'Routed by keyword rules (AI router unavailable).', 'fallback');
  }

  // Shortlist BEFORE the model sees anything. Packet 5.1 took the catalog from
  // 12 to 353; rendering all of them here would put ~8.5k tokens of prompt into
  // a cheap classify call on EVERY request, and ask the model to discriminate
  // between 353 candidates — which costs accuracy as well as money. Same problem
  // packet 10.3 solved for the tool catalog, same shape of answer: narrow first,
  // then let the model choose from a bounded set.
  // Clip each line too. Harvested `when` values are trigger-dense paragraphs
  // (~500 chars each), so 45 unclipped lines is still ~5.5k tokens. The router
  // only has to judge RELEVANCE, not execute the skill — the full instructions
  // are injected later by composeSkillGuidance for whichever 1-4 it picks. One
  // clipped line is enough to choose from, and takes the routing prompt to
  // roughly 1.5k.
  const catalog = shortlistForRouting(text)
    .map((s: Skill) => `${s.id} [${s.category}] — ${clipWhen(s.when)}`)
    .join('\n');
  const kinds = 'classify | extract | draft | reason | long | code';
  const system =
    'You are Hermes, a routing brain for a B2B outreach CRM. Given a user request, choose the work type and the relevant skills from a fixed catalog. Pick 1-4 skills that genuinely apply — do not pad. Respond with ONLY JSON.';
  const prompt =
    `USER REQUEST: "${text}"\n` +
    (ctx.ventureName ? `VENTURE: ${ctx.ventureName}\n` : '') +
    (ctx.leadGoal ? `LEAD GOAL: ${ctx.leadGoal}\n` : '') +
    (ctx.sectors?.length ? `SECTORS: ${ctx.sectors.join(', ')}\n` : '') +
    `\nSKILL CATALOG:\n${catalog}\n\n` +
    `Return JSON: {"intent": string, "taskKind": one of (${kinds}), "skillIds": string[], "rationale": string (one short sentence)}`;

  try {
    // Route the routing itself through the fast tier — cheap, short output.
    const raw = await generateText({
      system,
      prompt,
      temperature: 0.1,
      maxOutputTokens: 400,
      model: pickModel('classify'),
    });
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : {};
    const validKinds: TaskKind[] = ['classify', 'extract', 'draft', 'reason', 'long', 'code'];
    const taskKind: TaskKind = validKinds.includes(parsed.taskKind) ? parsed.taskKind : base.taskKind;
    const skillIds: string[] = Array.isArray(parsed.skillIds)
      ? parsed.skillIds.map(String).filter((id: string) => getSkill(id))
      : [];
    return finalize(
      String(parsed.intent || base.intent),
      taskKind,
      skillIds.length ? skillIds : base.skillIds,
      String(parsed.rationale || 'Routed by Hermes.'),
      'ai',
    );
  } catch {
    return finalize(base.intent, base.taskKind, base.skillIds, 'Routed by keyword rules (AI router error).', 'fallback');
  }
}

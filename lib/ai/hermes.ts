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
import { SKILLS, getSkill, type Skill } from '@/lib/skills/registry';

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

/**
 * Route a request to a plan. Tries a fast AI classification against the skill
 * catalog; on any problem falls back to the deterministic keyword router.
 */
export async function hermesRoute(request: string, ctx: HermesContext = {}): Promise<HermesPlan> {
  const text = String(request || '').trim();
  const base = deterministicPlan(text);  if (!textConfigured() || !text) {
    return finalize(base.intent, base.taskKind, base.skillIds, 'Routed by keyword rules (AI router unavailable).', 'fallback');
  }

  const catalog = SKILLS.map((s: Skill) => `${s.id} [${s.category}] — ${s.when}`).join('\n');
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

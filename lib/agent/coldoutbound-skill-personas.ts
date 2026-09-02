// Explicit skill -> outreach-persona mapping for the 50 coldoutbound skills.
//
// WHY THIS FILE EXISTS. personaSlugsForSkill() (lib/agent/persona-routing.ts)
// finds a persona by parsing a "## Agents Used" section out of a skill's
// instructions text. digital-marketing-pro skills carry that section (210
// references across the catalog); the 50 coldoutbound skills this repo's
// outreach personas (lib/agent/authored-personas.ts) are grounded in do NOT
// — they were never written with LeadRail's persona-routing convention in
// mind. Without an explicit map, every one of those 50 skills would route to
// no persona at all: the exact "imported by nothing" failure
// harvested-personas.ts already made once, this time at the routing layer
// instead of the registry layer. This map is what makes the outreach
// personas actually reachable from a routed skill.
//
// Every one of the 50 coldoutbound skill slugs (skills/<slug>/SKILL.md in
// growthenginenowoslawski/coldoutboundskills @ f24320d) maps to exactly ONE
// outreach persona slug — the inverse of each persona's `groundedIn` list in
// authored-personas.ts, plus a small number of skills (lead-magnet-brainstorm,
// the four playbook-*-page/-library/-ideas/-cleaning skills not named in any
// persona's suggested grounding) assigned by best editorial fit, noted below.
//
// personaSlugsForSkill() checks this map FIRST (by the skill's catalog slug)
// and only falls back to "## Agents Used" text-parsing when the slug isn't
// in it — so digital-marketing-pro's 210 existing references keep resolving
// exactly as before (see tests/persona-routing.test.ts).

/**
 * skill slug (as in coldoutboundskills/skills/<slug>/SKILL.md `name:`
 * frontmatter, and the plain-text slug LeadRail's own skill catalog would
 * use if these were ever harvested) -> the one outreach persona slug that
 * executes it.
 */
export const COLDOUTBOUND_SKILL_PERSONA_MAP: Record<string, string> = {
  // ---- outreach-list-builder (9) ----
  'blitz-list-builder': 'outreach-list-builder',
  'list-builder': 'outreach-list-builder',
  'list-expander': 'outreach-list-builder',
  'google-maps-list-builder': 'outreach-list-builder',
  'competitor-engagers': 'outreach-list-builder',
  'playbook-lookalikes': 'outreach-list-builder',
  'playbook-name-to-other-prospects': 'outreach-list-builder',
  'prospeo-search-api': 'outreach-list-builder',
  'clay-playbooks': 'outreach-list-builder',

  // ---- outreach-icp-strategist (5) ----
  'icp-onboarding': 'outreach-icp-strategist',
  'icp-prompt-builder': 'outreach-icp-strategist',
  'disco-like': 'outreach-icp-strategist',
  'positive-reply-scoring': 'outreach-icp-strategist',
  'list-quality-scorecard': 'outreach-icp-strategist',

  // ---- outreach-deliverability-lead (5) ----
  'deliverability-incident-response': 'outreach-deliverability-lead',
  'deliverability-test-public': 'outreach-deliverability-lead',
  'email-deliverability-audit': 'outreach-deliverability-lead',
  'spam-word-checker': 'outreach-deliverability-lead',
  'zapmail-domain-setup-public': 'outreach-deliverability-lead',

  // ---- outreach-copywriter (6) ----
  'campaign-copywriting': 'outreach-copywriter',
  'personalization-subagent-pattern': 'outreach-copywriter',
  'playbook-ai-specificity': 'outreach-copywriter',
  'smartlead-spintax': 'outreach-copywriter',
  // Not in any persona's suggested grounding list — assigned here on fit:
  // both are email-copy content decisions (what free hook to offer; how to
  // fill a fixed idea-bullet template), not list, signal, or ops work.
  'lead-magnet-brainstorm': 'outreach-copywriter',
  'playbook-creative-ideas': 'outreach-copywriter',

  // ---- outreach-campaign-architect (5) ----
  'campaign-strategy': 'outreach-campaign-architect',
  'cold-email-kickoff': 'outreach-campaign-architect',
  'cold-email-starter-kit': 'outreach-campaign-architect',
  'cold-email-weekly-rhythm': 'outreach-campaign-architect',
  'experiment-design': 'outreach-campaign-architect',

  // ---- outreach-signal-researcher (10) ----
  'playbook-hiring-surge': 'outreach-signal-researcher',
  'playbook-new-in-role': 'outreach-signal-researcher',
  'playbook-fundraising': 'outreach-signal-researcher',
  'playbook-job-posting-language': 'outreach-signal-researcher',
  'playbook-tech-on-website': 'outreach-signal-researcher',
  'playbook-pricing-page': 'outreach-signal-researcher',
  'auto-research-public': 'outreach-signal-researcher',
  'playbook-google-site-search': 'outreach-signal-researcher',
  // Not in any persona's suggested grounding list — assigned here on fit:
  // both are per-company research/personalization-fact skills of the same
  // shape as the ten above (find and verify one checkable public fact).
  'playbook-ad-library': 'outreach-signal-researcher',
  'playbook-case-study-page': 'outreach-signal-researcher',

  // ---- outreach-social-seller (4) ----
  'playbook-warm-intros': 'outreach-social-seller',
  'playbook-linkedin-engagement': 'outreach-social-seller',
  'playbook-social-posts': 'outreach-social-seller',
  'playbook-social-link-finding': 'outreach-social-seller',

  // ---- outreach-ops-engineer (6) ----
  'smartlead-api': 'outreach-ops-engineer',
  'smartlead-campaign-upload-public': 'outreach-ops-engineer',
  'smartlead-inbox-manager': 'outreach-ops-engineer',
  'prospeo-full-export': 'outreach-ops-engineer',
  // Not in any persona's suggested grounding list — assigned here on fit:
  // both are deterministic per-row data-hygiene transforms, the same shape
  // as the mechanical/ops work this persona otherwise owns.
  'playbook-company-name-cleaning': 'outreach-ops-engineer',
  'playbook-first-name-cleaning': 'outreach-ops-engineer',
};

// Calibration: what earns a place in durable memory, and what never does.
//
// This is the single place those rules live. That is the point — the failure
// this codebase keeps producing is one decision implemented in several places
// that then drift (four provider clients each reporting usage differently; two
// agent loops each handling a JSON failure differently). Extraction is the only
// writer to memory, and this is the only thing extraction asks.
//
// The bar is domain-specific and deliberately not the bar a personal assistant
// would use. For a CRM, "mentioned they're opening a second location" is worth
// remembering the first time it is said; for a personal assistant the
// equivalent would need to recur. So: things a person STATED or a system
// MEASURED are Tier 1 on first mention. Softer signals — preferences, tone,
// inferred performance patterns — need a second, independent occurrence.

import type { CandidateFact, Tier } from './types';

/** A rule that can veto a fact outright, by name so the log says which fired. */
interface Rule {
  name: string;
  test: RegExp;
}

// ---------------------------------------------------------------------------
// NEVER WRITTEN
// ---------------------------------------------------------------------------
//
// Enforced here, at extraction, before anything reaches the database. Not at
// projection, not at read: an excluded fact must not exist as an edge that
// merely happens not to be read today.
//
// Two distinct categories, and it is worth keeping them apart because they fail
// differently. Compliance exclusions protect the person the data is about.
// Inference exclusions protect the SYSTEM from believing its own guesses —
// which is the failure that compounds, because a wrong fact about one contact
// costs one relationship, while a wrong inferred rule about "what works" steers
// every future campaign until somebody notices.

const COMPLIANCE_EXCLUSIONS: Rule[] = [
  // Account numbers, card numbers, sort codes, IBANs.
  { name: 'financial-account', test: /\b(?:acct|account|card|iban|routing|sort\s?code)\b[^.]{0,20}\b[\d][\d\s-]{6,}\b/i },
  { name: 'card-number', test: /\b(?:\d[ -]?){13,19}\b/ },
  // Government identifiers.
  { name: 'government-id', test: /\b(?:ssn|social security|national insurance|nino|passport|tax\s?id|ein|driver'?s licen[cs]e)\b/i },
  // Health.
  // NOTE ON BOUNDARIES: a trailing \b after an alternation applies to the whole
  // group, so a PREFIX alternative like `pregnan` could never match
  // "pregnant" — the character after it is a word character. Prefixes carry
  // \w* explicitly; only whole words keep a closing \b.
  { name: 'health', test: /\b(?:diagnos\w*|medication|prescription|therapy|surgery|illness|disabilit\w*|pregnan\w*|mental health|medical)\b/i },
  // Protected attributes.
  { name: 'protected-attribute', test: /\b(?:religio\w*|ethnicit\w*|racial|race\b|sexual orientation|gender identity|union member\w*|political (?:party|affiliation)|immigration status)/i },
  // Credentials — mirrors the guard already in lib/agent/memory.ts.
  { name: 'credential', test: /\b(?:password|api[_\s-]?key|secret|token|bearer|private[_\s-]?key)\b/i },
  { name: 'opaque-token', test: /[A-Za-z0-9_\-]{32,}/ },
];

const INFERENCE_EXCLUSIONS: Rule[] = [
  // A read on someone's psychology or intent. Only what they said or did.
  {
    name: 'psychological-inference',
    test: /\b(?:seems?|appears?|sounds?|feels?|looks?)\s+(?:to be\s+)?(?:hesitant|uninterested|keen|eager|nervous|frustrated|serious|committed|ready)\b/i,
  },
  {
    name: 'buyer-judgement',
    test: /\b(?:tire[\s-]?kick\w*|not a real buyer|probably (?:not|won'?t|just)|unlikely to (?:buy|convert|close)|just browsing|no real intent)/i,
  },
  // A causal narrative the system invented. "Underperformed BECAUSE ..." is a
  // hypothesis; storing it as memory turns it into a premise for every later
  // decision. Only a human-confirmed cause may be written, and this path has no
  // way to know that, so it refuses all of them.
  {
    name: 'invented-causation',
    test: /\b(?:because|due to|driven by|caused by|as a result of|which is why)\b[^.]{0,80}\b(?:fatigue|saturation|lost interest|didn'?t resonate|wasn'?t compelling|poor timing|audience (?:is|was))\b/i,
  },
  // A conclusion drawn FROM a stated fact, where the conclusion was not stated.
  {
    name: 'derived-conclusion',
    test: /\b(?:so|therefore|which means|suggesting|implying|indicates? that)\b[^.]{0,60}\b(?:not worth|deprioriti|disqualif|won'?t close|dead lead|low priority)\b/i,
  },
];

export const EXCLUSION_RULES: Rule[] = [...COMPLIANCE_EXCLUSIONS, ...INFERENCE_EXCLUSIONS];

/** The rule that bars this fact, or null. Checked against `fact` AND `object`,
 *  because a compliant sentence can still carry an excluded value in its
 *  object slot. */
export function exclusionFor(c: CandidateFact): string | null {
  const haystack = `${c.fact} ${c.object}`;
  for (const r of EXCLUSION_RULES) if (r.test.test(haystack)) return r.name;
  return null;
}

// ---------------------------------------------------------------------------
// TIER 1 — durable on a single mention
// ---------------------------------------------------------------------------
//
// Matched on the PREDICATE first, because the predicate is normalised and the
// prose is not. Prose fallbacks exist for extractors that produce a loose
// predicate, but a clean predicate is what makes this reliable.

const TIER1_PREDICATES = new Set([
  // Identity / authority / structure
  'has_role', 'works_at', 'reports_to', 'owns', 'has_authority',
  // Commercial facts someone stated
  'has_budget', 'has_timeline', 'has_contract_date', 'has_requirement',
  'has_need', 'has_pain', 'raised_objection',
  // Decisions and commitments
  'decided', 'committed_to', 'confirmed', 'rejected', 'signed',
  // Marketing: explicit rules and measured outcomes
  'brand_voice_rule', 'compliance_constraint', 'must_not_receive',
  'achieved_metric', 'campaign_outcome',
]);

const TIER1_PROSE: Rule[] = [
  { name: 'stated-role', test: /\b(?:is the|works as|title is|promoted to|now heads?)\b/i },
  { name: 'stated-budget', test: /\bbudget\b[^.]{0,40}(?:\$|£|€|\d)/i },
  { name: 'stated-timeline', test: /\b(?:by|before|deadline|renewal|contract ends?|go[\s-]?live)\b[^.]{0,30}\b(?:q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december|\d{4})\b/i },
  { name: 'stated-requirement', test: /\b(?:needs?|requires?|must have|can'?t proceed without|blocker is)\b/i },
  { name: 'stated-objection', test: /\b(?:too expensive|concerned about|worried that|objection|pushed back on|hesitat\w+ because they said)\b/i },
  { name: 'stated-decision', test: /\b(?:agreed to|signed|confirmed|committed|approved|decided to|chose)\b/i },
  { name: 'brand-rule', test: /\b(?:never|always|do not|don'?t)\b[^.]{0,50}\b(?:use|say|send|write|mention|include)\b/i },
  { name: 'measured-outcome', test: /\b\d{1,3}(?:\.\d+)?%\s*(?:open|reply|click|conversion|response|engagement|ctr)\b/i },
];

// ---------------------------------------------------------------------------
// TIER 2 — needs a second occurrence, or explicit always/never framing
// ---------------------------------------------------------------------------

const TIER2_PREDICATES = new Set([
  'prefers_channel', 'prefers_style', 'communication_style',
  'sentiment', 'tone', 'personal_detail', 'observed_pattern',
]);

/** "always" / "never" framing turns a soft preference into a stated rule, which
 *  is a Tier 1 statement about an ongoing commitment rather than an observation. */
const ALWAYS_NEVER = /\b(?:always|never|every time|from now on|going forward)\b/i;

export interface TierVerdict {
  tier: Tier;
  /** Named rule that decided it. */
  rule: string;
}

/**
 * Which tier this candidate belongs to.
 *
 * Defaults to Tier 2, not Tier 1. An unrecognised fact is an observation until
 * something says otherwise — the asymmetry is deliberate, because a
 * wrongly-Tier-1 fact is acted on immediately while a wrongly-Tier-2 one is
 * merely reported.
 */
export function tierFor(c: CandidateFact): TierVerdict {
  const p = c.predicate.toLowerCase().trim();

  if (TIER1_PREDICATES.has(p)) return { tier: 1, rule: `tier1-predicate:${p}` };
  if (TIER2_PREDICATES.has(p)) {
    if (ALWAYS_NEVER.test(c.fact)) return { tier: 1, rule: 'tier1-always-never-framing' };
    return { tier: 2, rule: `tier2-predicate:${p}` };
  }

  for (const r of TIER1_PROSE) {
    if (r.test.test(c.fact)) return { tier: 1, rule: `tier1-prose:${r.name}` };
  }
  if (ALWAYS_NEVER.test(c.fact)) return { tier: 1, rule: 'tier1-always-never-framing' };

  return { tier: 2, rule: 'tier2-default-unrecognised' };
}

/** How many independent observations promote a Tier 2 edge into the review
 *  queue. NOT an auto-promotion: crossing this only makes it eligible for a
 *  human decision. See docs/MEMORY_ARCHITECTURE.md. */
export const TIER2_PROMOTION_THRESHOLD =
  Number(process.env.MEMORY_TIER2_THRESHOLD) || 3;

/** Longest fact worth carrying. Mirrors MAX_FACT_LENGTH in lib/agent/memory.ts
 *  so the two memory paths agree on what counts as a fact rather than a blob. */
export const MAX_FACT_LENGTH = 500;

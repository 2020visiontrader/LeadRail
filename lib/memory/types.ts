// Subject-scoped memory — shared types.
//
// The subject list is deliberately wider than contact/deal/account. For a
// marketing OS the highest-value long-term memory is often not about a person:
// `brand` (voice rules, what the brand will and will not say) is what every
// generation call should be conditioned on, and `campaign`/`segment`/`channel`/
// `creative_asset` are where "what actually worked" lives.
//
// `pattern` is its own subject type on purpose. A Tier 2 observation is a claim
// ABOUT the account's behaviour rather than a fact about any one record, and
// giving it a node means the promotion gate has something to point at.

export const SUBJECT_TYPES = [
  'contact', 'company', 'deal', 'campaign', 'segment',
  'channel', 'creative_asset', 'brand', 'account', 'pattern',
] as const;

export type SubjectType = (typeof SUBJECT_TYPES)[number];

export function isSubjectType(v: unknown): v is SubjectType {
  return typeof v === 'string' && (SUBJECT_TYPES as readonly string[]).includes(v);
}

/** Which record a fact is about. `id` is TEXT because brands.id is TEXT while
 *  every other subject table uses UUID — see migration 061. */
export interface SubjectRef {
  type: SubjectType;
  id: string;
  /** Display name at resolution time; cached onto the projection so a prompt
   *  never has to join back on the hot path. */
  label?: string;
}

export function subjectKey(s: SubjectRef): string {
  return `${s.type}:${s.id}`;
}

/**
 * 1 — durable on first mention. Identity, authority, a stated need, an
 *     objection, a decision or commitment, a measured outcome, an explicit
 *     brand or compliance rule. These are things someone SAID or a system
 *     MEASURED.
 * 2 — pattern candidate. A preference, a tone, an inferred performance
 *     pattern. Written, but marked as observed rather than operational: the
 *     system may report it, and may not autonomously act on it.
 *
 * There is no tier 3 value. Excluded content is discarded during extraction and
 * never reaches the database — not written and flagged, not written and
 * filtered at read. See EXCLUSION_RULES.
 */
export type Tier = 1 | 2;

export interface MemoryEdge {
  id: string;
  accountId: string;
  subjectType: SubjectType;
  subjectId: string;
  predicate: string;
  object: string;
  fact: string;
  tier: Tier;
  validFrom: string;
  invalidAt: string | null;
  conversationId: string | null;
  source: 'extraction' | 'capability' | 'import' | 'declared';
  occurrences: number;
}

/** A fact the extractor proposes, before tiering and exclusion have run. */
export interface CandidateFact {
  subject: SubjectRef;
  predicate: string;
  object: string;
  fact: string;
  /** When it became true in the world, if stated. Defaults to now. */
  validFrom?: string;
}

/** What happened to one candidate. Skips are recorded, not silently dropped —
 *  tuning a calibration threshold against real outcomes is impossible if the
 *  only thing you can see is what got through. */
export interface FactDecision {
  candidate: CandidateFact;
  outcome: 'written' | 'recurrence' | 'skipped';
  tier?: Tier;
  /** Which rule decided this, by name, so the log is answerable. */
  rule: string;
  edgeId?: string;
  supersededEdgeId?: string;
}

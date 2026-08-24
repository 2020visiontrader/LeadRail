// Tiered memory recall — L0 / L1 / L2 budgets.
//
// WHAT WAS WRONG WITH ONE SIZE. recallMemoryDigest returns the same flat list
// of facts whatever the turn is: twelve bullets, ranked by semantic match and
// recency, for "what's my lead count?" and for "plan next quarter" alike. Two
// costs fall out of that, in opposite directions.
//
// On a small turn the digest is dead weight — a dozen facts about ventures and
// preferences occupying context a one-line question had no use for, on every
// step of the loop.
//
// On a large turn twelve is not enough, and worse, WHICH twelve is decided by
// similarity alone. A decision the operator made three weeks ago ("we stopped
// targeting agencies under 10 people") and a passing note about a file name
// compete on equal footing, and the note can win on wording.
//
// So: classify each fact by what KIND of thing it is, score the kinds against
// each other, and pack greedily into a token budget. Three budgets, each a
// superset of the last, so a caller asks for the depth the turn justifies:
//
//   L0  ~200 tokens   decisions and commitments only — what must not be contradicted
//   L1  ~800 tokens   working context: decisions, preferences, active constraints
//   L2  ~2400 tokens  everything recalled, including background
//
// The classifier is keyword-based rather than a model call, on purpose: this
// runs inside context assembly, before the first token of the turn is
// generated, and an LLM round-trip here would put latency in front of every
// single message to buy ranking we can approximate well enough.

/** Kinds of remembered fact, most load-bearing first. */
export type FactKind = 'decision' | 'constraint' | 'preference' | 'identity' | 'note';

export const TIER_BUDGETS = { L0: 200, L1: 800, L2: 2400 } as const;
export type MemoryTier = keyof typeof TIER_BUDGETS;

/** Higher survives truncation. A decision outranks a preference because
 *  contradicting a decision is a visible error, while missing a preference is
 *  a missed nicety. */
const KIND_PRIORITY: Record<FactKind, number> = {
  decision: 10,
  constraint: 8,
  preference: 6,
  identity: 5,
  note: 2,
};

/** Which kinds each tier admits. L0 carries only what it would be wrong to
 *  contradict; L2 admits everything. */
const TIER_KINDS: Record<MemoryTier, FactKind[]> = {
  L0: ['decision', 'constraint'],
  L1: ['decision', 'constraint', 'preference', 'identity'],
  L2: ['decision', 'constraint', 'preference', 'identity', 'note'],
};

const KIND_HINTS: Record<FactKind, RegExp> = {
  // A choice that was made and should not be re-litigated or contradicted.
  decision: /\b(decided|decision|chose|chosen|agreed|approved|rejected|settled on|going with|we will|we won't|we stopped|moved to|switched to)\b/i,
  // A rule that bounds future work: budgets, exclusions, hard limits.
  constraint: /\b(never|always|must not|do not|don't|avoid|only|cap|limit|budget|maximum|minimum|no more than|at least|excluded?|off limits)\b/i,
  // How they like things done, without being a hard rule.
  preference: /\b(prefer|prefers|likes?|dislikes?|rather|favou?rite|usually|tends? to|style|tone|voice)\b/i,
  // Who or what something is — names, roles, relationships.
  identity: /\b(is a|is the|are the|works? at|founder|ceo|owner|runs?|based in|located|their name|called)\b/i,
  note: /.^/, // never matches; the fallback below assigns it
};

/** Cheap token estimate. Deliberately the same 4-chars-per-token rule the rest
 *  of the agent uses — being consistent with the loop's own accounting matters
 *  more here than being precisely right. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function classifyFact(fact: string): FactKind {
  // Order matters: a sentence can match several, and the first match wins
  // because the list runs most load-bearing first.
  for (const kind of ['decision', 'constraint', 'preference', 'identity'] as FactKind[]) {
    if (KIND_HINTS[kind].test(fact)) return kind;
  }
  return 'note';
}

export interface ScoredFact {
  fact: string;
  kind: FactKind;
  /** Position in the caller's original ranking — lower is more relevant.
   *  Preserved so semantic relevance still breaks ties within a kind. */
  rank: number;
}

export function scoreFacts(facts: string[]): ScoredFact[] {
  return facts.map((fact, rank) => ({ fact, kind: classifyFact(fact), rank }));
}

/**
 * Pack scored facts into one tier's budget.
 *
 * Sorted by kind priority first and the caller's own relevance ranking second,
 * then taken greedily until the budget is spent. Greedy rather than optimal:
 * the difference is a fact or two at the margin, and a knapsack solver in the
 * hot path of every turn is not worth that.
 */
export function packTier(scored: ScoredFact[], tier: MemoryTier): string[] {
  const admitted = TIER_KINDS[tier];
  const budget = TIER_BUDGETS[tier];
  const eligible = scored
    .filter((s) => admitted.includes(s.kind))
    .sort((a, b) => (KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind]) || (a.rank - b.rank));

  const out: string[] = [];
  let spent = 0;
  for (const s of eligible) {
    const cost = estimateTokens(s.fact) + 2; // the "- " and the newline
    if (spent + cost > budget) continue;     // skip, don't stop: a long fact
    out.push(s.fact);                        // should not block every shorter
    spent += cost;                           // one behind it
  }
  return out;
}

/**
 * Choose the tier a turn justifies.
 *
 * The signal is the shape of the request, not its subject. A question that
 * names a single thing needs almost no history; one that asks for planning,
 * strategy or a comparison is exactly where contradicting an old decision is
 * most expensive, so it gets the full recall.
 */
export function tierForRequest(message: string | undefined): MemoryTier {
  const text = (message || '').trim();
  if (!text) return 'L0';
  if (text.length > 400) return 'L2';
  if (/\b(plan|strategy|strategi[sz]e|roadmap|approach|why|compare|options|recommend|should we|next quarter|long.?term|review)\b/i.test(text)) {
    return 'L2';
  }
  if (text.length < 60 && /^(what|who|when|where|how many|list|show|check|is|are|do we|did we)\b/i.test(text)) {
    return 'L0';
  }
  return 'L1';
}

/** Render a packed tier as the prompt block. Empty string when nothing
 *  survived, so callers can splice it in unconditionally. */
export function renderTier(facts: string[]): string {
  if (!facts.length) return '';
  return facts.map((f) => `- ${f}`).join('\n');
}

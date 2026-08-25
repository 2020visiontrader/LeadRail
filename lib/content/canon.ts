// Brand canon — linearity as a constraint, not an adjective.
//
// WHAT THIS FIXES. A brand kit made of adjectives ("bold", "warm",
// "professional") loses every argument it has with a character limit. Put it in
// a prompt beside aspect ratios, hashtag rules and SEO keywords and the model
// spends its attention on the things that are checkable. That is why
// high-volume generation drifts into copy that could belong to anyone.
//
// The fix is two-sided, and neither half works alone:
//
//   INJECTION — the thesis is stated as a hard constraint, first and separately
//   from the style notes, with the enemy it argues against and the words it may
//   not use. Not "the brand is bold" but "the brand asserts X, against Y".
//
//   MEASUREMENT — after generation, the copy is scored against the thesis. A
//   rubric that asks a model "is this on-brand?" is grading its own homework.
//   Cosine distance to a fixed thesis vector is not: the anchor was written by
//   a human, embedded once, and does not move when the generator gets creative.
//
// LINEARITY IS NOT REPETITION. Identical phrasing across TikTok, LinkedIn and a
// Meta ad fails on all three. What stays fixed is the belief; the hook,
// vocabulary and pacing are supposed to change. So the scoring here measures
// whether the copy still ASSERTS the thesis, and never whether it repeats it.

import { supabase, dbReady } from '@/lib/db';
import { embedPassage, toPgVector } from '@/lib/agent/embeddings';

export interface BrandCanon {
  coreThesis: string | null;
  brandEnemy: string | null;
  anchorTakeaway: string | null;
  mandatoryLexicon: string[];
  bannedTerms: string[];
  hasEmbedding: boolean;
}

export async function loadCanon(accountId: string, brandId?: string | null): Promise<BrandCanon | null> {
  if (!dbReady() || !brandId) return null;
  const { data } = await supabase
    .from('brands')
    .select('core_thesis, brand_enemy, anchor_takeaway, mandatory_lexicon, banned_terms, thesis_embedding')
    .eq('id', brandId).eq('account_id', accountId).maybeSingle();
  if (!data) return null;
  return {
    coreThesis: data.core_thesis ?? null,
    brandEnemy: data.brand_enemy ?? null,
    anchorTakeaway: data.anchor_takeaway ?? null,
    mandatoryLexicon: Array.isArray(data.mandatory_lexicon) ? data.mandatory_lexicon : [],
    bannedTerms: Array.isArray(data.banned_terms) ? data.banned_terms : [],
    hasEmbedding: Boolean(data.thesis_embedding),
  };
}

/**
 * Store a canon and embed the thesis in the same call.
 *
 * The embedding is derived, never supplied — keeping it in step with the text
 * is the whole reason it can be trusted as an anchor. If embedding fails the
 * canon still saves: a brand with a thesis and no vector can still constrain
 * generation, it just cannot score drift, and that is a smaller loss than
 * refusing to save the thesis at all.
 */
export async function saveCanon(accountId: string, brandId: string, input: {
  coreThesis?: string;
  brandEnemy?: string;
  anchorTakeaway?: string;
  mandatoryLexicon?: string[];
  bannedTerms?: string[];
}): Promise<{ saved: true; embedded: boolean }> {
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (input.coreThesis !== undefined) patch.core_thesis = input.coreThesis;
  if (input.brandEnemy !== undefined) patch.brand_enemy = input.brandEnemy;
  if (input.anchorTakeaway !== undefined) patch.anchor_takeaway = input.anchorTakeaway;
  if (input.mandatoryLexicon !== undefined) patch.mandatory_lexicon = input.mandatoryLexicon;
  if (input.bannedTerms !== undefined) patch.banned_terms = input.bannedTerms;

  let embedded = false;
  if (input.coreThesis) {
    // The anchor is thesis + takeaway together: the thesis is the claim and the
    // takeaway is what it should leave behind, and copy can hold one while
    // losing the other.
    const anchorText = [input.coreThesis, input.anchorTakeaway].filter(Boolean).join(' ');
    const vec = await embedPassage(anchorText).catch(() => null);
    if (vec) { patch.thesis_embedding = toPgVector(vec); embedded = true; }
  }

  const { error } = await supabase.from('brands').update(patch).eq('id', brandId).eq('account_id', accountId);
  if (error) throw error;
  return { saved: true, embedded };
}

/**
 * The prompt block. Placed FIRST and alone, before platform mechanics.
 *
 * Order is load-bearing: the constraint that must survive contact with every
 * other instruction goes where attention is highest, and is phrased as a rule
 * rather than as description. "The brand is bold" is a hint; "every piece must
 * resolve to this claim" is a test the model can check its own draft against.
 */
export function canonBlock(canon: BrandCanon | null): string {
  if (!canon?.coreThesis) return '';
  const lines = [
    'BRAND THESIS — the one thing that may not vary. Everything below this bends; this does not.',
    `- The claim: ${canon.coreThesis}`,
  ];
  if (canon.brandEnemy) {
    lines.push(`- What it argues against: ${canon.brandEnemy}. A hook that agitates this belief is on-thesis; one that ignores it is generic.`);
  }
  if (canon.anchorTakeaway) {
    lines.push(`- What the reader must be left with, even with the logo removed: ${canon.anchorTakeaway}`);
  }
  if (canon.mandatoryLexicon.length) {
    lines.push(`- Words this brand owns, use them: ${canon.mandatoryLexicon.join(', ')}`);
  }
  if (canon.bannedTerms.length) {
    lines.push(`- NEVER use these, they dissolve the identity: ${canon.bannedTerms.join(', ')}`);
  }
  lines.push(
    '- Adapt the HOOK, the vocabulary and the pacing to the platform. Do NOT adapt the claim. Repeating the thesis word-for-word is a different failure from abandoning it — express it natively, assert it every time.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface LinearityReport {
  /** 0..10. Below 8 is a fail — see the threshold note on scoreLinearity. */
  score: number;
  pass: boolean;
  /** Cosine similarity to the thesis vector, or null when it could not run. */
  thesisSimilarity: number | null;
  /** Banned words that made it into the copy. */
  bannedUsed: string[];
  /** Owned words the copy did use. Informational, never a failure on its own —
   *  a piece can be perfectly on-thesis without reaching for the lexicon. */
  lexiconUsed: string[];
  reasons: string[];
}

/**
 * Semantic distance between generated copy and the brand's thesis.
 *
 * Returns null rather than a number when the brand has no vector or the
 * embedder is unreachable — "could not measure" and "measured badly" must not
 * collapse into the same value, or an outage silently starts failing content.
 */
async function thesisSimilarity(accountId: string, brandId: string, copy: string): Promise<number | null> {
  try {
    const vec = await embedPassage(copy);
    if (!vec) return null;
    const { data, error } = await supabase.rpc('brand_thesis_similarity', {
      p_account_id: accountId,
      p_brand_id: brandId,
      p_query: toPgVector(vec),
    });
    if (error || data === null || data === undefined) return null;
    const n = Array.isArray(data) ? data[0]?.similarity : data;
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

/** Similarity below this reads as a different argument, not a different angle.
 *
 *  Deliberately permissive. The thesis and a native TikTok hook SHOULD be far
 *  apart in wording — that is the point of linearity-not-repetition — so a
 *  tight threshold would reject exactly the platform-native copy we want. This
 *  catches copy that has wandered off the argument entirely, not copy that
 *  phrased it differently. */
const MIN_THESIS_SIMILARITY = 0.35;

/**
 * Score one piece against the canon.
 *
 * Deterministic checks only. There is no model call here on purpose: asking an
 * LLM whether its own output is on-brand produces agreeable answers, and this
 * gate exists precisely for the cases where the generator was confident and
 * wrong.
 */
export async function scoreLinearity(
  accountId: string,
  brandId: string | null | undefined,
  copy: string,
  canon?: BrandCanon | null,
): Promise<LinearityReport> {
  const resolved = canon ?? (brandId ? await loadCanon(accountId, brandId) : null);
  const reasons: string[] = [];

  // No canon is not a failure — most brands will not have one on day one, and
  // failing their content for it would make the feature a tax rather than a
  // guardrail.
  if (!resolved?.coreThesis) {
    return {
      score: 10, pass: true, thesisSimilarity: null, bannedUsed: [], lexiconUsed: [],
      reasons: ['No brand thesis is set, so linearity was not scored.'],
    };
  }

  const lower = copy.toLowerCase();

  // Word-boundary matched: "AI" must not fire inside "again", and a banned
  // term is banned as a word, not as a substring.
  const bannedUsed = resolved.bannedTerms.filter((t) => {
    const term = t.trim().toLowerCase();
    if (!term) return false;
    return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower);
  });
  const lexiconUsed = resolved.mandatoryLexicon.filter((t) => {
    const term = t.trim().toLowerCase();
    if (!term) return false;
    return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower);
  });

  const similarity = resolved.hasEmbedding && brandId
    ? await thesisSimilarity(accountId, brandId, copy)
    : null;

  let score = 10;

  if (bannedUsed.length) {
    // Each banned word is a deliberate rule the brand wrote down, so this bites
    // hard — two of them is already a fail on its own.
    score -= bannedUsed.length * 1.5;
    reasons.push(`Uses banned wording: ${bannedUsed.join(', ')}.`);
  }

  if (similarity !== null) {
    if (similarity < MIN_THESIS_SIMILARITY) {
      score -= 4;
      reasons.push(
        `The copy is semantically far from the brand thesis (${similarity.toFixed(2)} against a ${MIN_THESIS_SIMILARITY} floor) — it reads as a different argument, not a different angle.`,
      );
    }
  } else {
    reasons.push('Thesis similarity could not be measured, so this score rests on the lexicon checks alone.');
  }

  score = Math.max(0, Math.min(10, score));
  const pass = score >= 8 && bannedUsed.length === 0;
  if (pass && !reasons.length) reasons.push('On thesis, no banned wording.');

  return { score, pass, thesisSimilarity: similarity, bannedUsed, lexiconUsed, reasons };
}

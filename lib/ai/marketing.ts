// Marketing scaffolding — distilled from Skills/marketing-psychology,
// Skills/copywriting, Skills/social-content. Injected into generation prompts so
// output uses real frameworks (JTBD, PAS/AIDA, hooks, CTAs) rather than fluff.

/** Core copy frameworks the generator can be told to follow. */
export const COPY_FRAMEWORKS: Record<string, string> = {
  PAS: 'Problem → Agitate → Solution: name the pain, twist it, resolve with the offer.',
  AIDA: 'Attention → Interest → Desire → Action.',
  BAB: 'Before → After → Bridge: current pain, desired state, the product as the bridge.',
  '4Ps': 'Promise → Picture → Proof → Push.',
};

/** Mental models (from marketing-psychology) worth encoding in outreach/content. */
export const MENTAL_MODELS = [
  'Jobs to Be Done: sell the outcome the buyer hires the product for, not features.',
  'Loss aversion: frame the cost of inaction, not just the gain.',
  'Social proof: concrete numbers and named peers beat adjectives.',
  'Specificity: exact figures out-convert round claims.',
  'Reciprocity: lead with a useful insight before the ask.',
];

/** Reusable hook patterns for short-form/social. */
export const HOOK_PATTERNS = [
  'Contrarian: "Everyone says X. They\'re wrong."',
  'Result-first: "How we got <specific result> in <timeframe>."',
  'Mistake: "The <N> mistakes killing your <outcome>."',
  'Question: "What if <assumption> is costing you <loss>?"',
];

/** Standard block appended to generation system prompts. */
export function marketingGuidance(opts: { framework?: keyof typeof COPY_FRAMEWORKS } = {}): string {
  const fw = opts.framework ? COPY_FRAMEWORKS[opts.framework] : COPY_FRAMEWORKS.PAS;
  return [
    `Copy framework: ${fw}`,
    `Persuasion principles:\n${MENTAL_MODELS.map((m) => `- ${m}`).join('\n')}`,
    `Write concretely. Prefer specific numbers over adjectives. One clear CTA.`,
  ].join('\n\n');
}

// White-label: client-facing copy must never name the tools underneath it —
// neither the platforms content is cross-posted to nor the vendors LeadRail
// itself runs on. An operator's client reading "we use Apollo and Claude to
// research every prospect" learns exactly what they are paying a markup for.
//
// TWO LISTS, because one list cannot do this job.
//
// The previous single list held only cross-posting competitors and was matched
// with `includes()`, which got the problem exactly backwards. Every vendor in
// the actual stack passed untouched, while ordinary English failed: "circle
// back later" and "a buffer against seasonal dips" both tripped it, and the
// stripper then deleted the word mid-sentence, leaving "a against seasonal
// dips" in copy that had already been generated. "laterally" was flagged by the
// checker but not removable by the stripper, because the two functions did not
// even agree on what a match was — one used substrings, the other word
// boundaries. That is an unfixable FAIL, and an unfixable FAIL is how a quality
// gate teaches people to switch it off.
//
// So: unambiguous names match case-insensitively; names that are also ordinary
// English match only as proper nouns, and never at a sentence start, where
// English capitalises "Later" for reasons of its own.

/** Vendor and platform names that are never ordinary English. Substitutable:
 *  a neutral noun phrase fits wherever these appear. */
const BANNED_VENDORS = [
  // Cross-posting platforms.
  'postiz', 'hootsuite', 'metricool', 'sprout social',
  // The stack LeadRail runs on. The operator's client must never see these.
  'apollo.io', 'anthropic', 'openrouter', 'open router', 'huggingface',
  'hugging face', 'opencode', 'supabase', 'nvidia nim', 'serpapi', 'tavily',
];

/** Internal mechanics. Verb phrases, so no noun substitutes for them — the
 *  stripper cannot repair a sentence built around one. These are here so
 *  reviewContent FAILS the draft and it gets rewritten, which is the only
 *  actual fix. */
const BANNED_MECHANICS = ['repost as our own', 'cross-post to'];

const BANNED_ALWAYS = [...BANNED_VENDORS, ...BANNED_MECHANICS];

/** What a stripped vendor name is replaced WITH. Deleting it outright was
 *  leaving "Our team uses and to research every prospect." in copy that had
 *  already been generated — a broken sentence is a more obvious defect to a
 *  client than the vendor name would have been. */
const NEUTRAL = 'our platform';

/** Product names that are ALSO ordinary English words. Matched only when
 *  capitalised as a proper noun, and never sentence-initially — "Later, we
 *  will follow up" is a sentence, not a scheduling tool. */
const BANNED_PROPER_NOUN = ['Buffer', 'Later', 'Sprout', 'Claude', 'Apollo', 'Repurpose'];

/** Every white-label hit in `text`, as {term, index, length}. The ONE matcher —
 *  both the checker and the stripper read it, so they cannot disagree about
 *  what counts as a match. */
function whiteLabelHits(text: string): { term: string; index: number; length: number }[] {
  const hits: { term: string; index: number; length: number }[] = [];

  for (const term of BANNED_ALWAYS) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    for (let m = re.exec(text); m; m = re.exec(text)) {
      hits.push({ term, index: m.index, length: m[0].length });
    }
  }

  for (const term of BANNED_PROPER_NOUN) {
    const re = new RegExp(`\\b${term}\\b`, 'g'); // case-SENSITIVE
    for (let m = re.exec(text); m; m = re.exec(text)) {
      // Skip a sentence-initial capital: it carries no evidence of a brand.
      const before = text.slice(0, m.index).replace(/\s+$/, '');
      if (before === '' || /[.!?:]$/.test(before)) continue;
      hits.push({ term: term.toLowerCase(), index: m.index, length: m[0].length });
    }
  }

  return hits.sort((a, b) => a.index - b.index);
}

/** Last-resort sanitiser for generated output: substitute vendor names with a
 *  neutral phrase so the sentence still reads, and delete the mechanic phrases
 *  it cannot rewrite.
 *
 *  This is the belt, not the braces. It cannot repair arbitrary prose, and it
 *  is not meant to — reviewContent FAILS any draft containing these terms, so
 *  the real remedy is that the copy gets rewritten before it reaches anyone. */
export function whiteLabelGuard(text: string): string {
  const hits = whiteLabelHits(text);
  if (!hits.length) return text.trim();
  let out = '';
  let cursor = 0;
  for (const h of hits) {
    if (h.index < cursor) continue; // overlapping match already handled
    out += text.slice(cursor, h.index);
    // A vendor name occupies a noun slot, so a neutral noun keeps the sentence
    // intact. A mechanic phrase does not, so it goes.
    if (!BANNED_MECHANICS.includes(h.term)) out += NEUTRAL;
    cursor = h.index + h.length;
  }
  out += text.slice(cursor);
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
}

/** The distinct banned terms present in `text`. Same matcher as the stripper,
 *  so anything reported here is guaranteed removable. */
export function violatesWhiteLabel(text: string): string[] {
  return [...new Set(whiteLabelHits(text).map((h) => h.term))];
}

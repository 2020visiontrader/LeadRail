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

// White-label: content must never name the competitor platforms it will be
// cross-posted to, and must never expose internal repost mechanics.
const BANNED_TERMS = [
  'postiz', 'buffer', 'hootsuite', 'later', 'sprout', 'metricool',
  'repurpose', 'repost as our own', 'cross-post to',
];

/** Strip/flag competitor-platform and internal-mechanic mentions from output. */
export function whiteLabelGuard(text: string): string {
  let out = text;
  for (const term of BANNED_TERMS) {
    out = out.replace(new RegExp(`\\b${term}\\b`, 'gi'), '').replace(/\s{2,}/g, ' ');
  }
  return out.trim();
}

export function violatesWhiteLabel(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_TERMS.filter((t) => lower.includes(t));
}

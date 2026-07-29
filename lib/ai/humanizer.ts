// Humanizer layer — distilled from Skills/humanizer. Pure functions: strip
// AI-tell markers (dash-as-separator, underscores, stock cliches) from LLM
// output before it reaches a user. No LLM calls here.

/** Constraints to fold into every generation prompt via improvePrompt({ rules }). */
export const HUMANIZE_RULES: string[] = [
  'No em dashes or en dashes as clause separators — use a period, comma, or "and"/"so" instead',
  'No underscores anywhere in the output',
  'Avoid AI cliches: delve, dive into, game-changer, unlock, seamless, robust, leverage, synergy, elevate, cutting-edge, revolutionize, paradigm, holistic, furthermore, moreover, "it\'s worth noting", "I hope this finds you well"',
  'Write like a specific person emailing another specific person, not a brand voice',
];

const AI_CLICHES: [RegExp, string][] = [
  [/\bin today'?s fast-paced world\b/gi, ''],
  [/\bdelve into\b/gi, 'look into'],
  [/\bdive into\b/gi, 'look into'],
  [/\bgame[- ]?changers?\b/gi, 'a real shift'],
  [/\bunlock(s|ing|ed)? the\b/gi, 'get the'],
  [/\bseamless(ly)?\b/gi, 'smooth'],
  [/\brobust\b/gi, 'solid'],
  [/\bleverage[sd]?\b/gi, 'use'],
  [/\bsynerg(y|ies|istic)\b/gi, 'fit'],
  [/\belevate(s|d)? your\b/gi, 'improve your'],
  [/\bcutting[- ]?edge\b/gi, 'new'],
  [/\brevolutioniz(e|es|ing|ed)\b/gi, 'change'],
  [/\bparadigm shifts?\b/gi, 'big shift'],
  [/\bholistic\b/gi, 'complete'],
  [/\bfurthermore\b/gi, 'also'],
  [/\bmoreover\b/gi, 'also'],
  [/\bit'?s worth noting that\b/gi, ''],
  [/\bi hope this (email|message|note) finds you well\.?\s*/gi, ''],
  [/\bas an ai\b/gi, ''],
];

/**
 * Strip AI-tell markers from generated text: dash-as-separator, underscores,
 * and stock cliche phrases. Run on every LLM output before it reaches a user
 * or gets persisted.
 */
export function stripAiMarkers(text: string): string {
  if (!text) return text;
  let out = text;
  // Em/en dash used as a clause separator -> comma. Any remaining dash -> hyphen.
  out = out.replace(/\s+[—–]\s+/g, ', ');
  out = out.replace(/[—–]/g, '-');
  // Underscores in prose read as AI/technical artifacts -> space.
  out = out.replace(/_/g, ' ');
  for (const [pattern, replacement] of AI_CLICHES) {
    out = out.replace(pattern, replacement);
  }
  // Collapse artifacts left behind by the replacements above.
  out = out.replace(/ {2,}/g, ' ').replace(/,\s*,/g, ',').replace(/\s+([,.])/g, '$1');
  return out.trim();
}

/** Normalize a category/tag slug: hyphenated lowercase, never underscored. */
export function humanizeSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-');
}

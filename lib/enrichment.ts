import type { FitVerdict, Segment } from '@/lib/types';
import type { ApolloEnrichment } from '@/lib/integrations/apollo';
import { SEGMENT_SCORES, TITLE_KEYWORDS } from '@/lib/scoring';

export interface FitResult {
  verdict: FitVerdict;
  score: number; // 0-100, recomputed with enrichment signal
  reasons: string[];
}

const SENIORITY_WEIGHT: Record<string, number> = {
  owner: 1.0, founder: 1.0, c_suite: 1.0, partner: 0.95, vp: 0.85,
  head: 0.8, director: 0.75, manager: 0.6, senior: 0.55, entry: 0.4,
};

/**
 * Deterministic "is this lead worth pursuing" verdict from segment fit,
 * title seniority, and the enrichment payload (seniority + company size).
 * Kept rule-based so it runs without an LLM; an AI pass can layer on later.
 */
export function computeFitVerdict(
  contact: { segment?: string; title?: string; company?: string },
  enr: ApolloEnrichment | null
): FitResult {
  const reasons: string[] = [];
  const segFit = SEGMENT_SCORES[(contact.segment as Segment)] ?? 0.4;
  if (segFit >= 0.8) reasons.push(`strong segment fit (${contact.segment})`);

  const title = (enr?.title || contact.title || '').toLowerCase();
  let titleScore = 0.5;
  for (const [kw, s] of Object.entries(TITLE_KEYWORDS)) {
    if (title.includes(kw)) titleScore = Math.max(titleScore, s);
  }
  if (titleScore >= 0.85) reasons.push('decision-maker title');

  const seniorityKey = (enr?.seniority || '').toLowerCase().replace(/[^a-z]/g, '_');
  const seniority = SENIORITY_WEIGHT[seniorityKey] ?? 0;
  if (seniority >= 0.85) reasons.push(`senior (${enr?.seniority})`);

  const size = enr?.organization?.estimated_num_employees;
  let sizeSignal = 0.5;
  if (typeof size === 'number') {
    if (size >= 50 && size <= 5000) { sizeSignal = 0.8; reasons.push(`company size ${size}`); }
    else if (size > 5000) { sizeSignal = 0.6; }
    else { sizeSignal = 0.4; }
  }
  if (enr?.email_status === 'verified') reasons.push('verified email');
  if (!enr) reasons.push('no enrichment data — verdict from base signals only');

  const score = Math.round(
    (segFit * 0.3 + titleScore * 0.3 + Math.max(seniority, titleScore * 0.6) * 0.2 + sizeSignal * 0.2) * 100
  );

  let verdict: FitVerdict;
  if (score >= 75) verdict = 'good_fit';
  else if (score >= 55) verdict = 'maybe';
  else verdict = 'skip';

  return { verdict, score, reasons };
}

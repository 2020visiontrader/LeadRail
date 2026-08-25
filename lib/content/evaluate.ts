// The evaluator — one verdict, three independent checks.
//
// WHAT THIS IS FOR. A piece can be perfectly on-brand and still fail: 300
// characters over the limit, a hook that takes eight seconds to arrive on a
// surface that ranks on three, or a results claim that gets a paid ad rejected
// before it spends anything. Linearity was scored already; the other two were
// not, so the gate passed content that was going to fail somewhere else.
//
// THREE CHECKS, DELIBERATELY SEPARATE, because they fail for unrelated reasons
// and a single blended number hides which one:
//
//   SPEC        deterministic. Character limits, aspect ratios, missing parts.
//               Code can settle these, so no model is asked.
//   ALGORITHMIC how well it plays to what the platform ranks on. Hook arrival,
//               opening strength, structure. Heuristic, not a model call.
//   POLICY      whether a paid asset would survive ad review. Pattern-based,
//               and advisory rather than blocking — see below.
//
// NO MODEL CALLS IN HERE. That is the point of an evaluator: asking a model
// whether the copy it just wrote is good produces agreement, and this exists
// precisely for the cases where the generator was confident and wrong. Every
// check below is arithmetic or a pattern, which means it gives the same answer
// twice and can be argued with.

import type { PlatformSpec, FormatFamily } from './store';
import type { LinearityReport } from './canon';

export interface EvaluationIssue {
  check: 'spec' | 'algorithmic' | 'policy' | 'linearity';
  severity: 'block' | 'warn';
  message: string;
}

export interface Evaluation {
  /** 0..10 overall. A blend for sorting a board, never the reason for a
   *  decision — the issues are. */
  score: number;
  /** False when anything blocking was found. */
  pass: boolean;
  issues: EvaluationIssue[];
  specScore: number;
  algorithmicScore: number;
}

export interface EvaluateInput {
  hook: string;
  body: string;
  cta: string;
  hashtags?: string[];
  spec: PlatformSpec | null;
  family: FormatFamily;
  intent: 'organic' | 'paid';
  linearity?: LinearityReport | null;
  production?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Spec compliance — deterministic
// ---------------------------------------------------------------------------

function checkSpec(input: EvaluateInput, issues: EvaluationIssue[]): number {
  let score = 10;
  const assembled = [input.hook, input.body, input.cta].filter(Boolean).join('\n\n');

  if (!input.hook?.trim()) {
    issues.push({ check: 'spec', severity: 'block', message: 'There is no hook. The first line is the whole opening on every surface.' });
    score -= 5;
  }
  if (!input.body?.trim()) {
    issues.push({ check: 'spec', severity: 'block', message: 'There is no body — nothing carries the substance.' });
    score -= 5;
  }

  const limit = input.spec?.char_limit;
  if (limit && assembled.length > limit) {
    const over = assembled.length - limit;
    // Over the hard limit is a block: the platform will truncate it, and
    // truncation lands on the CTA, which is the part that asks.
    issues.push({
      check: 'spec',
      severity: 'block',
      message: `${assembled.length} characters against a ${limit} limit — ${over} over. It will be cut, and the cut lands on the CTA.`,
    });
    score -= 4;
  }

  // Short video needs its artefacts, or it is a caption pretending to be a
  // shoot. This is the check that catches the old failure directly.
  if (input.family === 'short_video') {
    const beats = Array.isArray(input.production?.beats) ? input.production!.beats : [];
    if (!beats.length) {
      issues.push({ check: 'spec', severity: 'block', message: 'No script beats — this is a caption, not something anyone can film.' });
      score -= 4;
    }
    if (!input.production?.openingFrame) {
      issues.push({ check: 'spec', severity: 'warn', message: 'No opening frame described. It is the thumbnail and the scroll-stopper; without it the first frame is whatever the generator felt like.' });
      score -= 1;
    }
  }

  return Math.max(0, score);
}

// ---------------------------------------------------------------------------
// Algorithmic fit — heuristic
// ---------------------------------------------------------------------------

/** Words that mean the sentence has not started yet. A hook that opens with one
 *  of these has spent its most valuable position on throat-clearing. */
const PREAMBLE = /^(in today'?s|in this|we all know|have you ever|let'?s talk about|it'?s no secret|as a|in the world of|when it comes to|are you (tired|struggling))/i;

/** Concrete markers: a number, a currency, a percentage, a time span. Copy
 *  carrying one of these is making a claim someone could check. */
const CONCRETE = /(\d[\d,.]*\s*(%|percent|x|hours?|days?|weeks?|months?|years?|k\b|m\b)|[$£€]\s?\d)/i;

function checkAlgorithmic(input: EvaluateInput, issues: EvaluationIssue[]): number {
  let score = 10;
  const hook = (input.hook || '').trim();

  if (PREAMBLE.test(hook)) {
    issues.push({
      check: 'algorithmic',
      severity: 'warn',
      message: 'The hook opens with preamble. The first clause is the most valuable position you have and it is being spent on warming up.',
    });
    score -= 3;
  }

  // Hook length matters most where a hold window is declared — that is the
  // platform telling us how long a viewer waits before leaving.
  const holdSeconds = input.spec?.hook_hold_seconds;
  if (holdSeconds) {
    // ~3 spoken words a second is the working rate for short-form delivery.
    const words = hook.split(/\s+/).filter(Boolean).length;
    const spokenSeconds = words / 3;
    if (spokenSeconds > holdSeconds) {
      issues.push({
        check: 'algorithmic',
        severity: 'warn',
        message: `The hook takes about ${spokenSeconds.toFixed(1)}s to deliver against a ${holdSeconds}s window. Most of the audience leaves before it lands.`,
      });
      score -= 3;
    }
  } else if (hook.length > 120) {
    issues.push({ check: 'algorithmic', severity: 'warn', message: 'The hook is long enough to be truncated before it makes its point.' });
    score -= 2;
  }

  if (!CONCRETE.test(`${hook} ${input.body}`)) {
    issues.push({
      check: 'algorithmic',
      severity: 'warn',
      message: 'Nothing concrete — no number, price, or timeframe. Abstract claims are the easiest thing to scroll past.',
    });
    score -= 2;
  }

  // Paid without an ask is a brand post that costs money.
  if (input.intent === 'paid' && !input.cta?.trim()) {
    issues.push({ check: 'algorithmic', severity: 'block', message: 'A paid asset with no call to action is spend with nowhere to land.' });
    score -= 4;
  }

  return Math.max(0, score);
}

// ---------------------------------------------------------------------------
// Ad policy — advisory
// ---------------------------------------------------------------------------

/** Shapes ad networks reject. Advisory, never blocking, and the reason matters:
 *  policy is enforced by a reviewer reading context, and a pattern cannot tell
 *  "guaranteed results" in a testimonial from the same words in a promise. A
 *  false block here stops a legitimate ad from ever being written; a false warn
 *  costs someone ten seconds. */
const POLICY_PATTERNS: { pattern: RegExp; message: string }[] = [
  {
    pattern: /\b(guaranteed?|guarantee)\b[^.\n]{0,40}\b(results?|income|weight|earnings?|approval)\b/i,
    message: 'Guaranteed-outcome wording. Meta, Google and TikTok all reject guaranteed results claims.',
  },
  {
    pattern: /\bbefore\s*(and|\/|&)\s*after\b/i,
    message: 'Before/after framing is prohibited for body, health and financial claims on Meta and TikTok.',
  },
  {
    pattern: /\b(you|your)\b[^.\n]{0,30}\b(diagnosed|disease|depression|anxiety|debt|bankrupt|overweight|divorced)\b/i,
    message: 'Implies a personal attribute about the viewer, which Meta prohibits — it asserts something about who is seeing the ad.',
  },
  {
    pattern: /\b(cure|cures|miracle|instantly?\s+(cure|heal|fix))\b/i,
    message: 'Cure or miracle wording. Rejected across every major network.',
  },
  {
    pattern: /\b(\d+)\s*(%|percent)\s*(of\s+)?(users?|customers?|people)\b[^.\n]{0,30}\b(lost|earned|made|gained)\b/i,
    message: 'A statistical outcome claim. Allowed only with substantiation on file, and it will be asked for.',
  },
];

function checkPolicy(input: EvaluateInput, issues: EvaluationIssue[]): void {
  // Only paid. Organic content is not reviewed by an ad network, and flagging
  // it there would train people to ignore the check where it matters.
  if (input.intent !== 'paid') return;
  const copy = `${input.hook} ${input.body} ${input.cta}`;
  for (const { pattern, message } of POLICY_PATTERNS) {
    if (pattern.test(copy)) {
      issues.push({ check: 'policy', severity: 'warn', message });
    }
  }
  if (input.spec?.ad_policy_notes) {
    issues.push({
      check: 'policy',
      severity: 'warn',
      message: `Check against this platform's rules before launching: ${input.spec.ad_policy_notes}`,
    });
  }
}

// ---------------------------------------------------------------------------

/**
 * Run all three checks and fold in the linearity verdict already computed.
 *
 * The overall score is a blend for sorting; the ISSUES are the reason for any
 * decision. That distinction matters — a single number invites "it scored 7,
 * ship it", which is exactly the judgement the issue list exists to prevent.
 */
export function evaluate(input: EvaluateInput): Evaluation {
  const issues: EvaluationIssue[] = [];
  const specScore = checkSpec(input, issues);
  const algorithmicScore = checkAlgorithmic(input, issues);
  checkPolicy(input, issues);

  if (input.linearity && !input.linearity.pass) {
    issues.push({
      check: 'linearity',
      severity: 'block',
      message: input.linearity.reasons.join(' ') || 'The copy does not read as this brand.',
    });
  }

  const linearityScore = input.linearity?.score ?? 10;
  // Weighted toward spec because a piece that cannot be posted is worth less
  // than one that posts and underperforms.
  const score = Math.round(((specScore * 0.4) + (algorithmicScore * 0.3) + (linearityScore * 0.3)) * 10) / 10;
  const pass = !issues.some((i) => i.severity === 'block');

  return { score, pass, issues, specScore, algorithmicScore };
}

// The learning loop — governed, which here means it never learns on its own.
//
// WHAT CLOSES HERE. Performance ingestion put numbers on the board and the
// canon fixes what the brand believes, but nothing connected them. So the
// engine could see that one pillar consistently outperformed another and had
// no way to act on it, and a human had to notice by reading a table.
//
// THE RULE THAT SHAPES EVERYTHING BELOW: this proposes, and a person accepts.
// Nothing here writes to the canon, the pillars, or the platform specs.
//
// That is not caution for its own sake. An engine that retunes its own brand
// rules from engagement data optimises for engagement, and what reliably wins
// on engagement — outrage, overclaiming, the format everyone else is already
// running — is rarely what a brand wants to be known for. Worse, drift with a
// feedback loop behind it is harder to catch than ordinary drift, because each
// step arrives with evidence attached and looks like a decision rather than a
// slide. The canon exists to be the one thing that does not move when the
// numbers move; a loop that edits it has removed the only fixed point in the
// system.
//
// So the output is a list of claims, each carrying what it rests on and how
// thin that evidence is. A person reads them and decides. The loop's job is to
// make the pattern visible and to be honest about how much it actually knows —
// not to be right.

import { performanceReport, type PatternObservation } from './performance';
import { loadCanon } from './canon';
import { listFindings } from './research';

/** Below this many samples on BOTH sides, a comparison is not evidence.
 *  Matches performance.ts deliberately — two different thresholds for the same
 *  question is how a claim gets laundered into significance by being asked
 *  twice. */
const MIN_SAMPLE = 5;

/** How much better one thing has to do before it is worth telling anyone.
 *  Engagement is noisy; a 6% gap between two pillars over eight posts each is
 *  the noise, and reporting it trains people to act on nothing. */
const MEANINGFUL_LIFT = 0.35;

export interface Proposal {
  kind: 'pillar_emphasis' | 'platform_focus' | 'research_refresh';
  /** What is being suggested, in one sentence, phrased as a suggestion. */
  suggestion: string;
  /** What it rests on. Never omitted — a proposal that cannot say why is a
   *  guess wearing a suit, and this one would be a guess with a number on it,
   *  which is worse. */
  evidence: string;
  /** How much weight this can bear. Stated so a reader does not have to infer
   *  it from a sample size buried in the evidence string. */
  confidence: 'low' | 'moderate';
}

export interface LearningReport {
  proposals: Proposal[];
  /** Why there is nothing to propose, or what the proposals cannot see.
   *  Populated even when proposals exist. */
  caveats: string[];
  /** Restated on every report so it cannot be lost between the data and the
   *  decision. */
  governance: string;
}

const GOVERNANCE =
  'These are observations, not changes. Nothing has been written to the brand canon, the pillars or the platform specs — ' +
  'accepting any of them is a decision for the account owner to make deliberately.';

/**
 * Look at what performed, and say what it might mean.
 *
 * Deliberately conservative in three ways: it needs a real sample on both
 * sides of any comparison, it needs a gap big enough not to be noise, and it
 * phrases every output as a question a human answers. Where it cannot support
 * a claim it says nothing rather than reaching for the nearest one — an empty
 * report is a correct outcome here, and far more useful than a plausible list.
 */
export async function proposeLearning(input: {
  accountId: string;
  brandId?: string | null;
}): Promise<LearningReport> {
  const caveats: string[] = [];
  const proposals: Proposal[] = [];

  const perf = await performanceReport({ accountId: input.accountId, brandId: input.brandId })
    .catch((e: any) => ({ scored: 0, observations: [] as PatternObservation[], caveats: [String(e?.message || e)] }));

  caveats.push(...(perf.caveats || []));

  const pillars = perf.observations.filter((o) => o.dimension === 'pillar');
  const platforms = perf.observations.filter((o) => o.dimension === 'platform');

  // --- pillar emphasis -----------------------------------------------------
  // Only ever compares the extremes, and only when both ends have a real
  // sample. Ranking a middle that is all within noise of each other produces
  // an ordering people read as a priority list.
  if (pillars.length >= 2) {
    const best = pillars[0];
    const worst = pillars[pillars.length - 1];
    const lift = worst.medianEngagement > 0
      ? (best.medianEngagement - worst.medianEngagement) / worst.medianEngagement
      : best.medianEngagement > 0 ? Infinity : 0;

    if (best.sample >= MIN_SAMPLE && worst.sample >= MIN_SAMPLE && lift >= MEANINGFUL_LIFT) {
      proposals.push({
        kind: 'pillar_emphasis',
        suggestion: `Consider giving "${best.value}" more of the rotation than "${worst.value}".`,
        evidence: `Median engagement ${best.medianEngagement} over ${best.sample} pieces versus ${worst.medianEngagement} over ${worst.sample}.`,
        // Never higher than moderate. This is observational data with no
        // control for timing, format, or what else was happening that week —
        // calling it high confidence would misrepresent what it is.
        confidence: best.sample >= MIN_SAMPLE * 3 && worst.sample >= MIN_SAMPLE * 3 ? 'moderate' : 'low',
      });
    } else if (pillars.length >= 2) {
      caveats.push('No pillar clearly outperformed another by enough to act on. Treat the rotation as working until it does.');
    }
  }

  // --- platform focus ------------------------------------------------------
  if (platforms.length >= 2) {
    const best = platforms[0];
    const worst = platforms[platforms.length - 1];
    if (best.sample >= MIN_SAMPLE && worst.sample >= MIN_SAMPLE
      && worst.medianEngagement > 0
      && (best.medianEngagement - worst.medianEngagement) / worst.medianEngagement >= MEANINGFUL_LIFT) {
      proposals.push({
        kind: 'platform_focus',
        suggestion: `${best.value} is carrying more than ${worst.value}. Worth asking whether ${worst.value} needs a different format rather than more posts.`,
        evidence: `Median engagement ${best.medianEngagement} over ${best.sample} pieces versus ${worst.medianEngagement} over ${worst.sample}.`,
        confidence: 'low',
      });
    }
  }

  // --- research staleness --------------------------------------------------
  // Not a performance signal at all, and included because it is the failure
  // this loop would otherwise cause: acting harder on last quarter's picture
  // of the market because the numbers from inside it look convincing.
  try {
    const findings = await listFindings(input.accountId, input.brandId);
    if (!findings.length) {
      caveats.push('No research on file, so none of this is set against what the market is actually doing.');
    } else {
      const newest = findings
        .map((f: any) => new Date(f.created_at).getTime())
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => b - a)[0];
      const days = newest ? Math.floor((Date.now() - newest) / 86_400_000) : null;
      if (days !== null && days > 60) {
        proposals.push({
          kind: 'research_refresh',
          suggestion: 'Re-run the research sweep before acting on any of the above.',
          evidence: `The newest finding on file is ${days} days old. Competitor positioning and platform behaviour both move faster than that.`,
          confidence: 'moderate',
        });
      }
    }
  } catch {
    caveats.push('Could not check how current the research is.');
  }

  const canon = await loadCanon(input.accountId, input.brandId).catch(() => null);
  if (!canon?.coreThesis) {
    caveats.push('This venture has no core thesis set, so there is no fixed point to judge any of this against.');
  }

  if (!proposals.length && !caveats.length) {
    caveats.push('Nothing in the data yet supports a suggestion either way.');
  }

  return { proposals, caveats, governance: GOVERNANCE };
}

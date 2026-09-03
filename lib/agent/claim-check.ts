// The last defence between a draft answer and the user: catching a claim that
// a real-world, outward-facing action ALREADY HAPPENED when this turn's own
// ledger shows it did not.
//
// PRODUCTION INCIDENT, 2026-09-02 14:28 UTC. User: "rework the drafts."
// Assistant: "The last batch already went out to all 13 marketing and
// e-commerce agency contacts." Nothing went out. The only tool that ran that
// turn was `draftOutreach`; the approvals table holds exactly one `sendEmail`
// row, ever. The assistant invented a completed send to 13 real people.
//
// Every existing defence against this (lib/agent/loop.ts's systemPrompt: "A
// result exists only if a tool returned it") is ADVICE TO THE MODEL. Nothing
// CHECKED the answer before it shipped, and composeAnswer faithfully polishes
// a fabricated claim into more confident prose. This module is the check —
// pure and independently testable, the same reason json-envelope.ts and
// stream-outcome.ts exist: the defect lives in the control flow BETWEEN
// otherwise-correct functions (a fluent model, a working compose pass, an
// accurate tool ledger), and a test that re-implements that path cannot see
// the bug the path itself produces.
//
// WHAT IT CATCHES: a sentence asserting a completed send, publish, launch,
// enrollment, schedule, or spend, for which this turn's ledger has no
// matching executed tool. "Executed" means the tool call actually ran —
// specifically excludes a sensitive tool that was only PROPOSED and is
// sitting on a `[needs approval]` card. That is exactly the incident's shape:
// draftOutreach ran, sendEmail did not, and the model said "went out" anyway.
//
// WHAT IT DELIBERATELY DOES NOT CATCH (bounding false positives — a mangled
// correct answer costs more than a missed fabrication going uncaught here;
// the system prompt is still the first line of defence):
//   - Future or intent phrasing: "I'll send these once you confirm", "I can
//     publish this when you say go". Only past-tense/completed forms trip the
//     detector at all ("sent", not bare "send").
//   - Negated or hedged claims: "hasn't been sent yet", "won't go out until
//     you approve" — these are already honest, so they pass through.
//   - Anything outside the five tracked categories (send, publish, enroll,
//     schedule, spend). A claim like "the lead was updated" is not checked —
//     narrower coverage was chosen over guessing at categories the tool names
//     don't clearly signal.
//   - Whether an executed tool actually SUCCEEDED. A `sendEmail` call that
//     ran but errored still counts as "executed" here — this module answers
//     "did anything happen", not "did it work". Tool-failure honesty is a
//     separate, existing concern (the observation text itself).
//   - The user quoting their own prior words back ("you said it already went
//     out — it didn't") reads as a claim by the surface pattern; this is a
//     known, accepted gap, not a fix attempted here.

/** One category of outward, real-world action a draft might claim happened. */
interface ActionCategory {
  name: 'send' | 'publish' | 'enroll' | 'schedule' | 'spend';
  /** Matches a sentence claiming this action COMPLETED. Past-tense/perfect
   *  forms only — deliberately excludes bare present/future forms so intent
   *  and plans ("I'll send", "can send") never trip it. */
  verbPattern: RegExp;
  /** Matches an executed tool's name as plausibly belonging to this category. */
  toolPattern: RegExp;
  /** What to say in place of a flagged sentence. */
  correction: string;
}

const CATEGORIES: ActionCategory[] = [
  {
    name: 'send',
    verbPattern: /\b(sent|emailed|mailed|delivered|dispatched|went out|gone out|has gone out)\b/i,
    // Deliberately NOT "outreach" or "draft" — draftOutreach is exactly the
    // tool the production incident shows running while a send is claimed;
    // matching on the send/deliver/mail verb, not the campaign noun, is what
    // keeps that tool from falsely backing a "went out" claim.
    toolPattern: /send|deliver|dispatch|mail/i,
    correction: "Correction: nothing has actually gone out yet — those are drafted, not sent.",
  },
  {
    name: 'publish',
    verbPattern: /\b(published|posted|went live|has gone live|launched)\b/i,
    toolPattern: /publish|post|launch/i,
    correction: "Correction: that hasn't actually been published yet — it's still a draft.",
  },
  {
    name: 'enroll',
    verbPattern: /\b(enrolled|added to the (?:sequence|campaign|list))\b/i,
    toolPattern: /enroll/i,
    correction: "Correction: nobody has actually been enrolled yet.",
  },
  {
    name: 'schedule',
    verbPattern: /\b(scheduled|booked)\b/i,
    toolPattern: /schedule|book|calendar/i,
    correction: "Correction: nothing has actually been scheduled yet.",
  },
  {
    name: 'spend',
    verbPattern: /\b(spent|charged|paid|billed)\b/i,
    toolPattern: /spend|charge|pay|budget|invoice/i,
    correction: "Correction: no money has actually been spent yet.",
  },
];

// A guard word anywhere in the sentence means the claim is already honest
// (negated) or already future/conditional — do not touch it. Deliberately
// broad: false-negatives here (a real fabrication slips through because it
// happens to contain "will" elsewhere in the sentence) are the accepted
// trade for never mangling a correct, hedged answer.
const GUARD_PATTERN =
  /\b(not|n't|never|won't|will|going to|about to|plan to|plans to|planning to|intend|intends|propose|proposes|once you|when you|after you|if you|yet\b)/i;

interface RawSentence {
  text: string;
  start: number;
  end: number;
}

/** Split into sentence-ish chunks with their original offsets, so a flagged
 *  one can be replaced in place without disturbing anything around it —
 *  newlines (bullet lists) are treated as boundaries too. */
function splitSentences(text: string): RawSentence[] {
  const out: RawSentence[] = [];
  const re = /[^.!?\n]+(?:[.!?]+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].trim().length === 0) continue;
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export interface ClaimCheckFlag {
  category: ActionCategory['name'];
  sentence: string;
}

export interface ClaimCheckResult {
  /** The draft, or the draft with unsupported completion claims downgraded. */
  message: string;
  /** True when at least one sentence was rewritten. */
  corrected: boolean;
  flags: ClaimCheckFlag[];
}

/**
 * Check a draft answer against what this turn's ledger shows actually ran.
 *
 * `executedTools` is the set of tool names that genuinely EXECUTED this turn
 * — callers pass `Object.keys(toolCalls)` from the loop, which is only ever
 * incremented at a real execution site (a plain tool call, a batch that ran,
 * a grant-covered sensitive call, a multi-read). A sensitive tool that was
 * proposed and is waiting on a `[needs approval]` card never reaches that
 * counter, so it correctly reads here as NOT run — exactly the incident's
 * shape (draftOutreach executed and counted; sendEmail never did).
 */
export function checkClaims(draft: string, executedTools: string[]): ClaimCheckResult {
  const flags: ClaimCheckFlag[] = [];
  if (!draft) return { message: draft, corrected: false, flags };

  const sentences = splitSentences(draft);
  let result = draft;
  // Replace from the end backwards so earlier offsets stay valid.
  for (let idx = sentences.length - 1; idx >= 0; idx--) {
    const s = sentences[idx];
    const trimmed = s.text.trim();
    if (!trimmed) continue;
    if (GUARD_PATTERN.test(trimmed)) continue;

    for (const cat of CATEGORIES) {
      if (!cat.verbPattern.test(trimmed)) continue;
      const ran = executedTools.some((t) => cat.toolPattern.test(t));
      if (ran) continue; // A real tool of this category executed — claim stands.

      flags.unshift({ category: cat.name, sentence: trimmed });
      // Replace just this sentence, in place, with a plain correction.
      // Leading/trailing whitespace inside the matched span is preserved so
      // spacing around the replacement stays sane.
      const leading = s.text.match(/^\s*/)?.[0] ?? '';
      const trailing = s.text.match(/\s*$/)?.[0] ?? '';
      result = result.slice(0, s.start) + leading + cat.correction + trailing + result.slice(s.end);
      break; // One category match is enough for this sentence.
    }
  }

  return { message: result, corrected: flags.length > 0, flags };
}

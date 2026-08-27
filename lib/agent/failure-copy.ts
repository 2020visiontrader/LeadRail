// Honest, state-aware copy for a turn that did not produce an answer.
//
// WHY THIS EXISTS. A user attached a document, watched three delegates
// finish (Ada, Vale, Otto — all checkmarked), and the turn still ended on:
//
//   "That run ended without finishing. Nothing was lost — ask again, or
//    check Logs."
//
// Every clause in that sentence was wrong for the moment it fired in:
//   - "check Logs" points a non-admin at a page their role guard refuses to
//     open (Logs lives under Admin — commit 5e3f000), and even an owner is
//     being told to go debug the product instead of being told what happened.
//   - "That run ended without finishing" describes OUR internal condition
//     (the stream closed with no terminal event), not the user's situation.
//   - "Nothing was lost" is false in the way that matters: the user's
//     message was saved, the ANSWER was not. Saying nothing was lost when
//     they received nothing reads as dismissive.
//   - "ask again" was advice the system already knew was wrong. Production
//     logs for the window this shipped in: 172 "ai router: candidate
//     failed", 84 "ai health: candidate quarantined", every tier down at
//     once. Retrying was guaranteed to fail again.
//
// This module is the single place that decides what to say instead, so the
// route handler (which knows WHICH failure happened) and this file (which
// knows HOW to phrase each kind honestly) stay separated the same way
// stream-outcome.ts and stream-guard.ts already split "what happened" from
// "how to talk about it". No variant here may name Logs, Admin, or any other
// internal page — see tests/stream-failure-copy.test.ts, which greps every
// exported message for exactly that.

import { healthSnapshot } from '@/lib/ai/health';

export type FailureReason =
  // The route's own try/catch caught a thrown error.
  | 'exception'
  // The `finally` block found terminalSent still false — the stream closed
  // (or reached its end) without ever sending final/needs_approval/error.
  | 'incomplete'
  // A thrown error already carried a message meant for the user's eyes —
  // e.g. "the document needs to be re-uploaded, the earlier copy expired" —
  // as opposed to an internal exception message like a stack trace or a
  // driver error code. Nothing in this codebase throws that shape yet; this
  // exists so a future call site that needs to say "here is what I need
  // from you" has somewhere honest to say it, without inventing a guess at
  // what the error text means.
  | 'blocked';

/**
 * Whether the AI providers themselves look broken right now, as opposed to
 * merely quiet or never-called. Read from the SAME breaker state the router
 * consults before every model call (lib/ai/health.ts) — this must never
 * guess or re-derive that signal, only report it.
 *
 * A candidate list is only meaningful once something has actually failed —
 * healthSnapshot() is empty on a cold process, and an empty snapshot must
 * not be read as "everything is down" (it would flip every ordinary error
 * into a false "providers are failing" claim). So this is true only when
 * there IS a snapshot and EVERY entry in it is currently held back — the
 * exact shape of the incident this file was written for: 84 quarantines,
 * every tier failing at once.
 */
export function providersLookDown(): boolean {
  const rows = healthSnapshot();
  return rows.length > 0 && rows.every((r) => r.heldForMs > 0);
}

const SAVED_PREFIX = 'Your message';

/** What survived, stated as a fact rather than a claim. `hadAttachment`
 *  widens it to cover the document the user attached — "nothing was lost"
 *  was false precisely because it papered over the difference between the
 *  message (which WAS kept) and the answer (which was not). */
function savedClause(hadAttachment: boolean): string {
  return hadAttachment
    ? `${SAVED_PREFIX} and the document you attached are saved.`
    : `${SAVED_PREFIX} is saved.`;
}

/**
 * The copy shown when the AI providers themselves are the problem — health
 * reports every known candidate currently quarantined. Telling the user to
 * "ask again" here would be telling them to repeat an action the system
 * already has evidence will fail; the honest, useful instruction is to wait
 * before retrying, because the failure is time-bound (a cooldown, a rate
 * limit, a quota reset) rather than something retrying immediately fixes.
 */
function providersDownMessage(hadAttachment: boolean): string {
  return (
    `${savedClause(hadAttachment)} The AI providers this runs on are failing right now, ` +
    `so this turn could not finish. Wait a few minutes before trying again — retrying ` +
    `immediately will hit the same failure.`
  );
}

/**
 * The route's own code threw before the turn could reach a terminal event,
 * and providers are NOT the identified cause (or health has no opinion —
 * e.g. the failure never reached a model call at all, a bad attachment
 * read, a database error). Advises a retry because, unlike the providers-
 * down case, there is no positive evidence this will fail again.
 */
function exceptionMessage(hadAttachment: boolean): string {
  return (
    `${savedClause(hadAttachment)} This turn hit an error before it could finish. ` +
    `Try again — if it keeps happening the same way, it isn't something a retry will fix.`
  );
}

/**
 * The stream closed with no terminal event and no thrown error either — the
 * `!terminalSent` fallback for a cause the route could not identify (the
 * platform cut the connection, the process was recycled mid-turn, etc.).
 * Kept deliberately vague about WHY, because inventing a reason we do not
 * have evidence for would be exactly the "internal-state" framing this file
 * exists to stop doing.
 */
function incompleteMessage(hadAttachment: boolean): string {
  return (
    `${savedClause(hadAttachment)} This turn could not be completed. Try again in a moment.`
  );
}

/** `detail` is the pre-written user-facing text a 'blocked' error carried —
 *  passed through rather than re-worded, because re-wording something
 *  already written for the user's eyes risks losing the specific thing they
 *  need to do. Still prefixed with what survived, for the same reason every
 *  other variant states it: that fact does not appear in `detail` on its
 *  own. */
function blockedMessage(hadAttachment: boolean, detail: string | undefined): string {
  const what = detail && detail.trim() ? detail.trim() : 'something is needed from you before this can continue.';
  return `${savedClause(hadAttachment)} ${what}`;
}

/**
 * Decide what to tell the user about a turn that did not produce an answer.
 *
 * `reason` says WHERE the route noticed the failure (its own catch, or the
 * finally block finding no terminal event); `providersDown` — read via
 * providersLookDown() by the caller and passed in rather than recomputed
 * here, so a test can pin the health state without needing a real breaker —
 * takes priority over `reason` because a provider outage is the same story
 * regardless of which code path happened to observe it first. The one
 * exception is 'blocked': a known "here is what I need from you" message is
 * not made about providers just because the breaker happens to be unhappy
 * at the same moment.
 */
export function turnFailureMessage(args: {
  reason: FailureReason;
  providersDown: boolean;
  hadAttachment?: boolean;
  /** Only consulted when reason === 'blocked'. */
  blockedDetail?: string;
}): string {
  const hadAttachment = args.hadAttachment ?? false;
  if (args.reason === 'blocked') return blockedMessage(hadAttachment, args.blockedDetail);
  if (args.providersDown) return providersDownMessage(hadAttachment);
  if (args.reason === 'exception') return exceptionMessage(hadAttachment);
  return incompleteMessage(hadAttachment);
}

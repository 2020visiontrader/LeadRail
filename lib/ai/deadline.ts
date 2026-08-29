// Shared helpers for the in-process turn deadline.
//
// THE BUG THIS EXISTS TO FIX: every model call in this codebase has its own
// per-call timeout (zoask 120s, openrouter 30s x up to 17 chain entries,
// opencode 35s), and every one of those correctly aborts on its own. Nothing
// ever bounded their SUM. lib/agent/loop.ts's step loop can make several
// model calls in one turn, each of which can itself retry across a model
// chain, and none of those retries knew how much of the turn's overall
// budget was already spent — so a turn that "aborted" three times in a row
// could still run for minutes.
//
// THE FIX is an ABSOLUTE deadline (an epoch-ms timestamp), not a duration.
// A duration captured once at the top of a turn and handed down unchanged at
// every nested call would silently re-arm on every hop — "30s from now",
// computed fresh at each of three retries, adds up to 90s, which is exactly
// the unbounded-sum bug this file exists to prevent. An absolute timestamp
// shrinks correctly on its own as wall-clock time passes, with no caller
// needing to know how much time already elapsed above it.
//
// ADDITIVE BY CONSTRUCTION: every function below treats `undefined` as "no
// deadline" and every helper here is a no-op in that case (isPastDeadline is
// always false, remainingMs is Infinity, boundedTimeoutMs never shrinks
// below the provider's own constant). A caller that never passes deadlineAt
// gets byte-identical behaviour to before this file existed.

/** True once `deadlineAt` (if set) has passed. Always false for an undefined
 *  deadline — this is what keeps every existing, deadline-less caller
 *  unaffected. */
export function isPastDeadline(deadlineAt: number | undefined): boolean {
  return deadlineAt != null && Date.now() >= deadlineAt;
}

/** Milliseconds left until `deadlineAt`, or Infinity when there is none.
 *  Never negative — a caller that needs to know "is there time left at all"
 *  should check isPastDeadline first rather than comparing this to 0. */
export function remainingMs(deadlineAt: number | undefined): number {
  if (deadlineAt == null) return Infinity;
  return Math.max(0, deadlineAt - Date.now());
}

/** The abort timer's actual budget for one call: never larger than the
 *  provider's own constant — this may only TIGHTEN a timeout, never loosen
 *  one — and never larger than what remains before the deadline. With no
 *  deadline, remainingMs is Infinity and this returns providerTimeoutMs
 *  unchanged. */
export function boundedTimeoutMs(providerTimeoutMs: number, deadlineAt: number | undefined): number {
  return Math.min(providerTimeoutMs, remainingMs(deadlineAt));
}

/** A deadline has a distinct `name`/`code` so it never reads, in logs or in
 *  `app_logs`, as an ordinary provider failure (a timeout, a 429, a 5xx).
 *  Those are the provider's fault; this is the turn's clock running out —
 *  a different fact, and one worth being able to filter on afterwards. */
export class DeadlineExceededError extends Error {
  code = 'deadline_exceeded' as const;
  cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    // Not `super(message, options)`: this repo's tsconfig targets ES2020,
    // whose Error type does not declare the (ES2022) cause option — set it
    // as a plain property instead of widening the lib target for one field.
    super(message);
    this.name = 'DeadlineExceededError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

/** Build the distinct error thrown when a scope (a client's model chain, or
 *  the router's candidate loop) stops BECAUSE the deadline passed rather than
 *  because every candidate failed on its own merits. `cause`, when given, is
 *  the last real provider error seen before the deadline hit — kept for
 *  debugging, never mistaken for the reason the call stopped. */
export function deadlineExceededError(scope: string, cause?: unknown): DeadlineExceededError {
  return new DeadlineExceededError(
    `${scope}: turn deadline exceeded — stopped before starting another attempt that could not have finished in time`,
    cause !== undefined ? { cause } : undefined,
  );
}

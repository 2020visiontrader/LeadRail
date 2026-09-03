// The in-flight half of cooperative stop (see loop.ts's stopRequested/
// stopSalvageFraming for the between-steps half, which this is additive to,
// not a replacement for).
//
// THE GAP: the between-steps check runs before a model call starts and after
// it returns — never during. The two slowest calls in a turn (route, then
// compose) are each a single unbroken model call with a p50 of 39s and a p90
// of 74s (production numbers), so a stop clicked one second into either one
// waited out the rest of it. Nothing inside an in-flight call would ever see
// a stop flip, because the flag lives in Postgres (agent_conversations.
// stop_requested_at, set by a DIFFERENT HTTP request — POST /api/agent/stop)
// and nothing was polling it while the call was running.
//
// THE FIX: while `run` is in flight, poll isStopRequested (lib/agent/memory.ts
// — its running_since comparison is reused as-is, never reimplemented here)
// on a plain interval, and abort an AbortController the moment it flips. The
// signal is handed to `run`, which threads it down to generateChat/streamChat
// (lib/ai/router.ts) and from there to whichever provider client's fetch is
// actually in flight — see lib/ai/abort.ts for how a stop-caused abort is
// told apart from that same client's own internal timeout.
import { isStopRequested } from './memory';

/** Poll interval while a call is in flight. 3s against the production p50
 *  (39s) costs roughly 13 extra DB reads per call on the slow end — the
 *  stated, accepted price of the feature. Deliberately not tighter: a faster
 *  poll would not meaningfully improve perceived stop latency (a user is not
 *  timing this to the second) but would multiply DB load on every single
 *  model call, including the overwhelming majority nobody ever stops. */
export const STOP_POLL_MS = 3_000;

/**
 * Run `run` with an AbortSignal that fires when a stop is requested on
 * `conversationId` WHILE `run` is in flight.
 *
 * No `conversationId` — a delegate sub-run, or a turn that has not persisted
 * a conversation yet — means there is nothing for POST /api/agent/stop to
 * target, so `run` is invoked with `undefined` and NO interval is ever
 * created: no watcher, no polling, byte-identical to before this existed.
 *
 * The interval is ALWAYS cleared in `finally`, regardless of how `run`
 * settles (resolved, rejected, or rejected BECAUSE of the very abort this
 * function triggered) — a call that completes must never leave a timer
 * running behind it.
 */
export async function withStopWatch<T>(
  conversationId: string | undefined,
  accountId: string,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (!conversationId) return run(undefined);

  const ctrl = new AbortController();
  const timer = setInterval(() => {
    // Fail-open, exactly like loop.ts's own stopRequested(): a transient DB
    // read failure must never itself abort a call nobody asked to stop.
    isStopRequested(conversationId, accountId)
      .then((stopped) => {
        if (stopped) ctrl.abort();
      })
      .catch(() => {});
  }, STOP_POLL_MS);

  try {
    return await run(ctrl.signal);
  } finally {
    clearInterval(timer);
  }
}

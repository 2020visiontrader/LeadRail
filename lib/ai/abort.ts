// Shared shape for a model call cut short by an external caller (the agent
// loop's in-flight stop watcher — see lib/agent/stop-watch.ts), as distinct
// from every OTHER way a call can end early.
//
// THE PROBLEM THIS FIXES: every provider client already owns an internal
// AbortController for its own timeout (zoask 120s, opencode 35s, openrouter
// 30s x chain). A caller-supplied `signal` (this file's whole purpose) has to
// be able to abort the SAME fetch without disturbing that internal timer, and
// — critically — the two must be tellable apart afterwards. An internal
// timeout is an ordinary provider failure and the router's existing
// candidate/fallback logic must keep treating it exactly as it does today
// (try the next tier). An external abort is a USER STOP: the whole call
// chain must end right there, never spend more by trying another candidate.
// Conflating the two would either (a) make a stop silently keep spending, or
// (b) make an ordinary timeout stop the whole ladder instead of falling
// through — both are regressions this type exists to prevent.
//
// `code` (not just the class) is exported and checked, matching this
// codebase's existing convention for cross-cutting error kinds (see
// DeadlineExceededError in lib/ai/deadline.ts) — a plain string survives
// serialization and duck-typing in places `instanceof` cannot reach, while
// `instanceof` (via the exported class) is still what every in-process
// catch block in this repo actually checks.
export class StoppedError extends Error {
  code = 'stopped' as const;
  constructor(message = 'stopped: aborted by an external stop request') {
    super(message);
    this.name = 'StoppedError';
  }
}

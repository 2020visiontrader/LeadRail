// Per-candidate health for the model selector.
//
// This is the tier circuit breaker from router.ts, moved out and re-keyed.
// The semantics are unchanged and deliberately so — they were arrived at from
// live evidence (see BREAKER_OPEN_AFTER below) and this is not the place to
// relitigate them. What changes is the KEY.
//
// WHY PER CANDIDATE INSTEAD OF PER TIER. "openrouter" is not one thing. It is
// one key in front of ~17 models sitting behind different upstream providers,
// each with its own rate limit and its own retirement schedule. One model
// returning 429 opened the breaker for the whole tier, taking sixteen healthy
// models offline for a minute because of one saturated pool. The same applies
// to a registry chain, where "the account's models" are individually enabled
// rows that fail for individually different reasons.
//
// So a candidate is whatever the selector will actually attempt: a ladder tier
// where the client owns its own internal chain, or a single ai_models row.
//
// LATENCY IS RECORDED BUT DOES NOT REORDER, by default. router.ts documents
// ladder order as an operator decision (AI_TIER_ORDER, set from a measured
// probe) rather than something the code guesses at, and quietly overriding
// that from a rolling average would take the decision away from the person who
// made it deliberately. The measurement is kept and exposed so the operator can
// act on it; AI_HEALTH_REORDER=1 opts into letting it sort automatically.

import { log } from '@/lib/logger';

// A tier that TIMES OUT is far more expensive than a slow one: it burns its
// full timeout on every call before yielding. Observed live — NIM was ordered
// first on measured 413ms latency, then went down upstream, and every model
// call started paying 30s waiting for it to fail before OpenRouter answered in
// 500ms. On a 10-step agent run that is five minutes of pure waiting.
//
// OPENING AFTER ONE FAILURE, NOT TWO. The evidence: 18 NIM failures in four
// hours of ordinary use, each paying its full timeout before the ladder moved
// on. With the threshold at two, the SECOND call of every cooldown window also
// pays that cost — and inside a fan-out, where one turn makes many model calls,
// that repeats. One failure is enough signal to quarantine for a minute; the
// cost of being wrong is a single extra trial call after the cooldown, which is
// exactly what this was designed to tolerate.
const OPEN_AFTER = Number(process.env.AI_BREAKER_OPEN_AFTER) || 1;
const COOLDOWN_MS = Number(process.env.AI_BREAKER_COOLDOWN_MS) || 60_000;

/** Opt-in: sort healthy candidates by measured latency. Off by default — see
 *  the note at the top of this file about whose decision the order is. */
export const HEALTH_REORDER = process.env.AI_HEALTH_REORDER === '1';

/** How much a new sample moves the rolling latency. High enough to react to a
 *  provider degrading within a handful of calls, low enough that one slow
 *  answer does not reorder anything. */
const EWMA_ALPHA = 0.3;

interface Entry {
  fails: number;
  openedAt: number;
  /** Rolling mean latency of SUCCESSFUL calls, in ms. Failures are excluded on
   *  purpose: a timeout's latency describes the timeout constant, not the
   *  model, and folding it in makes a dead candidate look merely slow. */
  ewmaMs: number | null;
  successes: number;
  totalFails: number;
}

const entries = new Map<string, Entry>();

function entryFor(id: string): Entry {
  let e = entries.get(id);
  if (!e) {
    e = { fails: 0, openedAt: 0, ewmaMs: null, successes: 0, totalFails: 0 };
    entries.set(id, e);
  }
  return e;
}

/**
 * Whether this candidate should be held back right now.
 *
 * Reading it is not free of side effects: once the cooldown has elapsed the
 * entry is stepped down so exactly ONE trial call goes through, and a failed
 * trial re-quarantines immediately rather than having to fail the full count
 * again. That was true of the original breaker and callers depend on it.
 */
export function quarantined(id: string): boolean {
  const e = entries.get(id);
  if (!e || e.fails < OPEN_AFTER) return false;
  if (Date.now() - e.openedAt >= COOLDOWN_MS) {
    e.fails = OPEN_AFTER - 1;
    return false;
  }
  return true;
}

export function recordSuccess(id: string, latencyMs?: number): void {
  const e = entryFor(id);
  if (e.fails >= OPEN_AFTER) log.info('ai health: candidate recovered', { candidate: id });
  e.fails = 0;
  e.successes += 1;
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0) {
    e.ewmaMs = e.ewmaMs == null ? latencyMs : e.ewmaMs * (1 - EWMA_ALPHA) + latencyMs * EWMA_ALPHA;
  }
}

export function recordFailure(id: string): void {
  const e = entryFor(id);
  e.fails += 1;
  e.totalFails += 1;
  if (e.fails >= OPEN_AFTER) e.openedAt = Date.now();
  if (e.fails === OPEN_AFTER) {
    log.warn('ai health: candidate quarantined', { candidate: id, cooldownMs: COOLDOWN_MS });
  }
}

/**
 * Split a candidate list into what to try now and what to hold back, keeping
 * the caller's order within each half.
 *
 * Quarantined candidates are moved to the BACK rather than dropped. The old
 * breaker skipped them and then, if that had hidden everything, re-ran the
 * whole list ignoring the breaker — two passes to express "prefer healthy, but
 * never refuse to try". One ordered list says the same thing once, and means a
 * caller can no longer forget the second pass.
 */
export function orderByHealth<T>(candidates: T[], idOf: (c: T) => string): T[] {
  const healthy: T[] = [];
  const held: T[] = [];
  for (const c of candidates) (quarantined(idOf(c)) ? held : healthy).push(c);

  if (HEALTH_REORDER) {
    // Unmeasured candidates sort as if average rather than best or worst: a
    // model nobody has called yet should not leapfrog a proven fast one, and
    // should not be buried below a proven slow one either.
    const rank = (c: T) => entries.get(idOf(c))?.ewmaMs ?? Number.POSITIVE_INFINITY;
    const measured = healthy.filter((c) => entries.get(idOf(c))?.ewmaMs != null);
    const unmeasured = healthy.filter((c) => entries.get(idOf(c))?.ewmaMs == null);
    measured.sort((a, b) => rank(a) - rank(b));
    return [...measured, ...unmeasured, ...held];
  }

  return [...healthy, ...held];
}

export interface HealthRow {
  candidate: string;
  successes: number;
  fails: number;
  consecutiveFails: number;
  /** Rolling mean latency of successful calls, ms. Null until one succeeds. */
  ewmaMs: number | null;
  /** Ms remaining on the current quarantine, 0 when not held. */
  heldForMs: number;
}

/** Read-only snapshot for diagnostics. */
export function healthSnapshot(): HealthRow[] {
  const now = Date.now();
  return [...entries.entries()].map(([candidate, e]) => ({
    candidate,
    successes: e.successes,
    fails: e.totalFails,
    consecutiveFails: e.fails,
    ewmaMs: e.ewmaMs == null ? null : Math.round(e.ewmaMs),
    heldForMs: e.fails >= OPEN_AFTER ? Math.max(0, COOLDOWN_MS - (now - e.openedAt)) : 0,
  }));
}

/** Tests only — the module is process-global by design. */
export function resetHealth(): void {
  entries.clear();
}

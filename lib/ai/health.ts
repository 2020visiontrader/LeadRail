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
// Base cooldown period in milliseconds; actual cooldown is calculated via
// getCooldownMs() based on consecutive failure count.
const BASE_COOLDOWN_MS = Number(process.env.AI_BREAKER_COOLDOWN_MS) || 60_000;

/** Opt-in: sort healthy candidates by measured latency. Off by default — see
 *  the note at the top of this file about whose decision the order is. */
export const HEALTH_REORDER = process.env.AI_HEALTH_REORDER === '1';

/** How much a new sample moves the rolling latency. High enough to react to a
 *  provider degrading within a handful of calls, low enough that one slow
 *  answer does not reorder anything. */
const EWMA_ALPHA = 0.3;

// Exponential backoff steps in milliseconds: 1min, 5min, 15min, 30min.
// Index = consecutiveFails - OPEN_AFTER (clipped to array length).
const BACKOFF_MS = [60_000, 300_000, 900_000, 1_800_000];

interface Entry {
  consecutiveFails: number;
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
    e = { consecutiveFails: 0, openedAt: 0, ewmaMs: null, successes: 0, totalFails: 0 };
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
  if (!e || e.consecutiveFails < OPEN_AFTER) return false;
  const cooldownMs = getCooldownMs(e.consecutiveFails);
  return Date.now() - e.openedAt < cooldownMs;
}

function getCooldownMs(consecutiveFails: number): number {
  // consecutiveFails >= OPEN_AFTER here
  const backoffIndex = Math.min(consecutiveFails - OPEN_AFTER, BACKOFF_MS.length - 1);
  return BACKOFF_MS[backoffIndex];
}

/** 0 for a candidate that isn't held; otherwise ms remaining on its cooldown. */
function remainingCooldownMs(id: string): number {
  const e = entries.get(id);
  if (!e || e.consecutiveFails < OPEN_AFTER) return 0;
  return Math.max(0, getCooldownMs(e.consecutiveFails) - (Date.now() - e.openedAt));
}

export function recordSuccess(id: string, latencyMs?: number): void {
  const e = entryFor(id);
  if (e.consecutiveFails >= OPEN_AFTER) log.info('ai health: candidate recovered', { candidate: id });
  e.consecutiveFails = 0;
  e.openedAt = 0;
  e.successes += 1;
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0) {
    e.ewmaMs = e.ewmaMs == null ? latencyMs : e.ewmaMs * (1 - EWMA_ALPHA) + latencyMs * EWMA_ALPHA;
  }
}

export function recordFailure(id: string): void {
  const e = entryFor(id);
  e.consecutiveFails += 1;
  e.totalFails += 1;
  if (e.consecutiveFails >= OPEN_AFTER) {
    e.openedAt = Date.now();
    if (e.consecutiveFails === OPEN_AFTER) {
      log.warn('ai health: candidate quarantined', { 
        candidate: id, 
        cooldownMs: getCooldownMs(e.consecutiveFails) 
      });
    }
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

  // Within the held group, try whoever is closest to recovering first. A
  // candidate deep in backoff (30min, after repeated proven failures) has
  // given far more evidence of being broken than one on its first 60s
  // cooldown — it should be the last thing attempted when nothing healthy
  // exists, not tried in its original ladder slot ahead of a candidate that
  // may have already recovered. Observed live: a full-ladder outage (every
  // tier down at once) tries every held candidate every call regardless of
  // depth, so the most persistently dead one costs exactly as much as the
  // one most likely to answer. Stable sort keeps equal-cooldown candidates
  // (e.g. two that just failed once) in the caller's original order.
  held.sort((a, b) => remainingCooldownMs(idOf(a)) - remainingCooldownMs(idOf(b)));

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
  return [...entries.entries()].map(([candidate, e]) => {
    const heldForMs = e.consecutiveFails >= OPEN_AFTER
      ? Math.max(0, getCooldownMs(e.consecutiveFails) - (now - e.openedAt))
      : 0;
    return ({
      candidate,
      successes: e.successes,
      fails: e.totalFails,
      consecutiveFails: e.consecutiveFails,
      ewmaMs: e.ewmaMs == null ? null : Math.round(e.ewmaMs),
      heldForMs,
    });
  });
}

/** Tests only — the module is process-global by design. */
export function resetHealth(): void {
  entries.clear();
}
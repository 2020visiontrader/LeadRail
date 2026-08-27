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
//
// ─────────────────────────────────────────────────────────────────────────
// FAILURE TAXONOMY (added after the 2026-08-27 production trace).
// ─────────────────────────────────────────────────────────────────────────
// The breaker used to know only ONE thing about a failure: that it happened.
// `recordFailure(id)` took no status, no error type — so a 30s NIM timeout, a
// HuggingFace 402 ("depleted your monthly included credits"), and an
// OpenRouter 404 on a permanently retired model slug all walked the exact same
// exponential ladder (60s, 5min, 15min, 30min, repeat). In 24 hours that
// produced 172 candidate failures and 84 quarantines — almost all of them a
// dead OpenRouter slug and an out-of-credit HuggingFace key being retried
// every 30–60 minutes forever, because nothing in this file could tell "will
// work again soon" from "will never work again".
//
// The fix is not a smarter number, it is admitting these are different KINDS
// of failure that call for different SCHEDULES:
//   transient        — timeout, 5xx, network blip. Short exponential backoff.
//                       This is the behaviour the breaker already had; nothing
//                       here changes for this class.
//   rate_limited      (429) — honour the provider's own Retry-After when it
//                       sends one; otherwise hold for minutes, not seconds.
//                       A saturated pool clears on its own schedule, and a
//                       60s guess is usually wrong in the same direction.
//   quota_exhausted    (402, "depleted"/"insufficient credit") — hold until
//                       the next billing reset, computed as a real instant
//                       (default: the 1st of next month, UTC), not a fixed
//                       duration. Retrying every 30 minutes against a
//                       monthly quota is 1,440 wasted round-trips before it
//                       has any chance of succeeding.
//   gone               (404, "model unavailable"/"no endpoints found", a
//                       retired slug) — PERMANENT. This model id will never
//                       answer again on its own; only a human swapping the
//                       slug fixes it. Logged once, loudly, at error level —
//                       this is the exact class that produced 172 silent
//                       failures because nothing escalated past a warn.
//   auth               (401) — PERMANENT until credentials change. Also
//                       logged loudly once. `recordSuccess` clears it, which
//                       is how a credential rotation recovers automatically
//                       without a code change.
//
// A caller that does not classify (an older call site, or a status this
// taxonomy doesn't recognise) gets 'transient' by default — the exact old
// behaviour — so nothing regresses by omission; see recordFailure below.

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

// Exponential backoff steps in milliseconds for the TRANSIENT class only: 1min,
// 5min, 15min, 30min. Index = consecutiveFails - OPEN_AFTER (clipped to array
// length). Unchanged from before this file grew a taxonomy.
const BACKOFF_MS = [60_000, 300_000, 900_000, 1_800_000];

// Rate-limited (429) default hold when the provider sends no Retry-After.
// MINUTES, not the old 60s default — a saturated pool that didn't bother to
// say when it clears is not signalling "try again in a minute" the way a
// plain transient failure is.
const RATE_LIMIT_DEFAULT_MS = Number(process.env.AI_RATE_LIMIT_COOLDOWN_MS) || 5 * 60_000;

/** Opt-in: sort healthy candidates by measured latency. Off by default — see
 *  the note at the top of this file about whose decision the order is. */
export const HEALTH_REORDER = process.env.AI_HEALTH_REORDER === '1';

/** How much a new sample moves the rolling latency. High enough to react to a
 *  provider degrading within a handful of calls, low enough that one slow
 *  answer does not reorder anything. */
const EWMA_ALPHA = 0.3;

export type FailureKind = 'transient' | 'rate_limited' | 'quota_exhausted' | 'gone' | 'auth';

export type ResetPeriod = 'daily' | 'weekly' | 'monthly';

const DEFAULT_RESET_PERIOD: ResetPeriod = 'monthly';

/**
 * What the caller learned about a failure, handed to recordFailure so the
 * cooldown can match the KIND of failure rather than just its count.
 *
 * Every field is optional and `kind` defaults to 'transient' — a call site
 * that doesn't classify (or a status this taxonomy doesn't recognise) gets
 * exactly the old exponential-backoff behaviour, so nothing that hasn't been
 * updated to pass one regresses.
 */
export interface FailureInfo {
  kind?: FailureKind;
  /** HTTP status, when there is one. Carried through only for logs. */
  status?: number;
  /** Provider's own Retry-After, already resolved to milliseconds — see
   *  parseRetryAfterMs. Only consulted for 'rate_limited'. */
  retryAfterMs?: number;
  /** How often THIS provider's quota resets. Only consulted for
   *  'quota_exhausted'; defaults to 'monthly' (see resetPeriodFor). */
  resetPeriod?: ResetPeriod;
  /** Lowercase-insensitive provider hint (e.g. 'huggingface', 'openrouter')
   *  used to look up a per-provider reset-period override. Optional — when
   *  absent only the global default/env var applies. */
  provider?: string;
  /** Short human-readable reason, surfaced in the loud gone/auth log. */
  detail?: string;
}

/**
 * Classify a thrown error into a FailureInfo the way router.ts's runCandidates
 * is meant to before calling recordFailure.
 *
 * Reads the SAME error shape every provider client in lib/ai already throws:
 * `err.status` (HTTP status code) and `err.detail` (the provider's own error
 * body, truncated). See lib/ai/openrouter.ts, huggingface.ts, nim.ts,
 * zoask.ts, opencode.ts — each sets both on every non-timeout failure.
 *
 * Order matters: 401 is checked before the detail-text scan because a bad key
 * can return a body that happens to contain "credit" language from a generic
 * error page, and auth is the more specific, more actionable diagnosis.
 */
export function classifyFailure(err: any, provider?: string): FailureInfo {
  const status = Number(err?.status) || 0;
  const detail = String(err?.detail || err?.message || '');
  const d = detail.toLowerCase();

  if (status === 401) return { kind: 'auth', status, detail, provider };

  if (
    status === 404 ||
    /model[_ ]not[_ ]found|no endpoints found|unavailable for free|unknown model|model is unavailable/.test(d)
  ) {
    return { kind: 'gone', status, detail, provider };
  }

  if (status === 402 || /depleted|insufficient credit|out of credit|quota exceeded/.test(d)) {
    return { kind: 'quota_exhausted', status, detail, provider };
  }

  if (status === 429) {
    return { kind: 'rate_limited', status, detail, provider, retryAfterMs: err?.retryAfterMs };
  }

  return { kind: 'transient', status, detail, provider };
}

/**
 * Parse an HTTP Retry-After header value into milliseconds. Accepts both
 * forms the spec allows: a delta in seconds ("120") or an HTTP-date
 * ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns undefined for anything absent or
 * unparseable — the caller falls back to RATE_LIMIT_DEFAULT_MS in that case,
 * never to zero (a zero hold is indistinguishable from "not rate limited").
 */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const secs = Number(trimmed);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/**
 * How often a provider's quota resets, for the quota_exhausted class.
 *
 * Defaults to monthly — the case that motivated this (HuggingFace's Inference
 * Providers credits, "depleted your monthly included credits") resets on the
 * 1st, and nothing here has enough information to assume any OTHER provider
 * resets more often than that. Override per provider with
 * AI_QUOTA_RESET_PERIOD_<PROVIDER> (e.g. AI_QUOTA_RESET_PERIOD_HUGGINGFACE=
 * daily), or pass `resetPeriod` explicitly in FailureInfo when the caller
 * already knows it.
 */
export function resetPeriodFor(provider: string | undefined, requested?: ResetPeriod): ResetPeriod {
  if (requested) return requested;
  if (provider) {
    const envVal = process.env[`AI_QUOTA_RESET_PERIOD_${provider.toUpperCase()}`];
    if (envVal === 'daily' || envVal === 'weekly' || envVal === 'monthly') return envVal;
  }
  const globalEnv = process.env.AI_QUOTA_RESET_PERIOD;
  if (globalEnv === 'daily' || globalEnv === 'weekly' || globalEnv === 'monthly') return globalEnv;
  return DEFAULT_RESET_PERIOD;
}

/**
 * Milliseconds from `from` until the next reset instant for `period`, all in
 * UTC so the answer does not depend on the server's local timezone.
 *
 *   daily   — next UTC midnight.
 *   weekly  — next UTC Monday 00:00.
 *   monthly — the 1st of next month, UTC 00:00 (matches HuggingFace's billing
 *             cycle, the case this was built for).
 *
 * Exported and pure (takes `from` rather than reading Date.now() itself) so a
 * test can assert against a fixed instant instead of racing the clock.
 */
export function msUntilNextReset(period: ResetPeriod, from: Date = new Date()): number {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const day = from.getUTCDate();

  let next: Date;
  if (period === 'daily') {
    next = new Date(Date.UTC(y, m, day + 1, 0, 0, 0, 0));
  } else if (period === 'weekly') {
    const weekday = from.getUTCDay(); // 0 = Sunday .. 6 = Saturday
    const daysUntilMonday = ((8 - weekday) % 7) || 7; // always the NEXT Monday, never "today"
    next = new Date(Date.UTC(y, m, day + daysUntilMonday, 0, 0, 0, 0));
  } else {
    next = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0));
  }
  return Math.max(0, next.getTime() - from.getTime());
}

interface Entry {
  consecutiveFails: number;
  openedAt: number;
  /** Duration of the CURRENT hold, computed once when the entry opens (or
   *  re-opens) and reused by quarantined()/remainingCooldownMs() until the
   *  next failure or a success. Infinity for the permanent classes (gone,
   *  auth) — see quarantined() below for what that means for ordering. */
  cooldownMs: number;
  /** Classification of the most recent failure. Null for an entry that has
   *  never failed, or that just recovered via recordSuccess. */
  kind: FailureKind | null;
  /** Set once a 'gone'/'auth' classification has been logged at error level,
   *  so a candidate stuck in the permanent class does not re-log on every
   *  subsequent attempt — "log loudly, once" per the taxonomy above. Reset on
   *  recordSuccess so a later recurrence logs again. */
  loggedPermanent: boolean;
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
    e = {
      consecutiveFails: 0, openedAt: 0, cooldownMs: 0, kind: null, loggedPermanent: false,
      ewmaMs: null, successes: 0, totalFails: 0,
    };
    entries.set(id, e);
  }
  return e;
}

/** The cooldown for a freshly-opened (or re-opened) entry, given its
 *  classification. Transient reuses the pre-existing exponential ladder,
 *  keyed off consecutiveFails exactly as before this file had a taxonomy —
 *  see the module header for why the other four classes need their own
 *  schedules instead of that one number. */
function computeCooldownMs(kind: FailureKind, consecutiveFails: number, info: FailureInfo | undefined): number {
  switch (kind) {
    case 'rate_limited': {
      const fromHeader = info?.retryAfterMs;
      return typeof fromHeader === 'number' && fromHeader > 0 ? fromHeader : RATE_LIMIT_DEFAULT_MS;
    }
    case 'quota_exhausted': {
      const period = resetPeriodFor(info?.provider, info?.resetPeriod);
      return msUntilNextReset(period);
    }
    case 'gone':
    case 'auth':
      return Infinity;
    case 'transient':
    default: {
      const backoffIndex = Math.min(consecutiveFails - OPEN_AFTER, BACKOFF_MS.length - 1);
      return BACKOFF_MS[backoffIndex];
    }
  }
}

/**
 * Whether this candidate should be held back right now.
 *
 * Reading it is not free of side effects: once the cooldown has elapsed the
 * entry is stepped down so exactly ONE trial call goes through, and a failed
 * trial re-quarantines immediately rather than having to fail the full count
 * again. That was true of the original breaker and callers depend on it.
 *
 * An Infinity cooldown (the 'gone'/'auth' classes) never elapses, so this
 * returns true forever — the entry is held back permanently short of a
 * recordSuccess (a credential rotation recovering an 'auth' candidate; a
 * 'gone' candidate has no legitimate way back short of an operator changing
 * the model id, at which point it is a different candidate anyway).
 */
export function quarantined(id: string): boolean {
  const e = entries.get(id);
  if (!e || e.consecutiveFails < OPEN_AFTER) return false;
  if (!Number.isFinite(e.cooldownMs)) return true;
  return Date.now() - e.openedAt < e.cooldownMs;
}

/** 0 for a candidate that isn't held; otherwise ms remaining on its cooldown.
 *  A permanent (Infinity) hold reports Number.MAX_SAFE_INTEGER rather than
 *  Infinity so it sorts dead last in orderByHealth's held-group ordering
 *  without needing Infinity-aware comparison logic anywhere else. */
function remainingCooldownMs(id: string): number {
  const e = entries.get(id);
  if (!e || e.consecutiveFails < OPEN_AFTER) return 0;
  if (!Number.isFinite(e.cooldownMs)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, e.cooldownMs - (Date.now() - e.openedAt));
}

export function recordSuccess(id: string, latencyMs?: number): void {
  const e = entryFor(id);
  if (e.consecutiveFails >= OPEN_AFTER) log.info('ai health: candidate recovered', { candidate: id });
  e.consecutiveFails = 0;
  e.openedAt = 0;
  e.cooldownMs = 0;
  e.kind = null;
  e.loggedPermanent = false;
  e.successes += 1;
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0) {
    e.ewmaMs = e.ewmaMs == null ? latencyMs : e.ewmaMs * (1 - EWMA_ALPHA) + latencyMs * EWMA_ALPHA;
  }
}

/**
 * Record a failed attempt and schedule the next one.
 *
 * `info` is optional and, when omitted, behaves exactly as the pre-taxonomy
 * breaker did: every failure is treated as 'transient' and walks the same
 * exponential ladder. This is the safe default the task asked for — a call
 * site that has not been updated to classify still compiles and still gets a
 * cooldown, just not a tailored one.
 */
export function recordFailure(id: string, info?: FailureInfo): void {
  const kind: FailureKind = info?.kind || 'transient';
  const e = entryFor(id);
  e.consecutiveFails += 1;
  e.totalFails += 1;
  e.kind = kind;
  if (e.consecutiveFails >= OPEN_AFTER) {
    e.openedAt = Date.now();
    e.cooldownMs = computeCooldownMs(kind, e.consecutiveFails, info);

    if (kind === 'gone' || kind === 'auth') {
      // Loud, once. This is the exact class that produced 172 silent
      // candidate failures in 24 hours — a dead slug retried forever at warn
      // level, where nobody was looking. This needs a human to pick a
      // replacement model or rotate a credential; error level plus "once" is
      // what makes that finding show up without flooding the log on every
      // subsequent attempt.
      if (!e.loggedPermanent) {
        e.loggedPermanent = true;
        log.error(
          kind === 'gone'
            ? 'ai health: candidate permanently unavailable — will not recover on its own, replace the model id'
            : 'ai health: candidate permanently unauthorized — will not recover on its own, rotate the credential',
          undefined,
          { candidate: id, status: info?.status ?? null, detail: (info?.detail || '').slice(0, 200) },
        );
      }
    } else if (e.consecutiveFails === OPEN_AFTER) {
      log.warn('ai health: candidate quarantined', {
        candidate: id,
        kind,
        cooldownMs: e.cooldownMs,
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
 *
 * A 'gone'/'auth' (permanent) candidate is a held candidate like any other —
 * it is never PREFERRED (remainingCooldownMs sorts it dead last, behind every
 * timed hold) and it is never the thing a healthy alternative loses to, but it
 * is not removed from the list either. If literally everything else is also
 * down, this is still the same "degrade safely, never refuse to try" contract
 * the rest of the file already keeps — a permanently dead model is one last,
 * unlikely attempt, not a guaranteed answer, but a guaranteed answer was never
 * this function's job.
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
  /** Ms remaining on the current quarantine, 0 when not held. Reports
   *  Number.MAX_SAFE_INTEGER, not Infinity, for a permanent hold — see
   *  remainingCooldownMs. */
  heldForMs: number;
  /** Classification of the most recent failure, null if it has never failed
   *  (or just recovered). Surfaced so a diagnostics page can say WHY
   *  something is held, not just that it is. */
  kind: FailureKind | null;
  /** True for the gone/auth classes — this candidate will not recover on its
   *  own no matter how long it waits. */
  permanent: boolean;
}

/** Read-only snapshot for diagnostics. */
export function healthSnapshot(): HealthRow[] {
  return [...entries.entries()].map(([candidate, e]) => ({
    candidate,
    successes: e.successes,
    fails: e.totalFails,
    consecutiveFails: e.consecutiveFails,
    ewmaMs: e.ewmaMs == null ? null : Math.round(e.ewmaMs),
    heldForMs: remainingCooldownMs(candidate),
    kind: e.kind,
    permanent: !Number.isFinite(e.cooldownMs),
  }));
}

/** Tests only — the module is process-global by design. */
export function resetHealth(): void {
  entries.clear();
}

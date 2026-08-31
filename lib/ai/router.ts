// AI routing ladder — drop-in replacement for OpenCode's public text API.
//
// Two layers, tried in order:
//   0. Configurable registry (lib/ai/providers.ts) — ONLY consulted when the
//      caller passes `accountId` AND that account has rows in ai_routing
//      (migration 023). Per-account providers + active/fallback chain,
//      configured from Settings -> Models. Every call is logged to ai_usage.
//   1. Hardcoded ladder — the STATIC/cold-start seed order only; the live
//      order is normally decided by measured latency (see ./health's
//      HEALTH_REORDER, on by default since 2026-08-31). See
//      DEFAULT_TIER_ORDER's own header comment below for the reasoning and
//      the production evidence behind the current seed order:
//      1. OpenRouter (paid MODEL_CHAIN — see ./openrouter's own header for
//         the roster and its ordering) — fastest proven tier, last-48h p50
//         8.2s over successful calls (its ALL-TIME average in ai_usage is
//         ~142.8s, but that figure is misleading — it includes an earlier
//         era of failures and ~300s deadline-hitting calls; the recent p50
//         is the number that describes current behaviour).
//      2. Ask Zo  (user's Claude subscription — Haiku when set as the Zo account
//         default model; billed to the user's own Anthropic subscription) —
//         proven but slow, p50 35.6s.
//      3. OpenCode Go (deepseek-v4-pro) — genuinely the slowest measured
//         path, not merely unproven: its registry route (DeepSeek V4 Flash,
//         paid) has 152 successful calls at ~46.1s average; its hardcoded
//         tier's own API key 401s (21/21 calls failed 2026-08-27 to
//         2026-08-28, none since — a dead key, not an untested one).
//
// NVIDIA NIM and HuggingFace were removed from the ladder entirely (production
// incident, 2026-08-28: NIM timing out, HuggingFace returning 402 "depleted
// your monthly included credits" — both were disabled account-side too, see
// ai_providers.enabled). Their client modules (./nim, ./huggingface) are left
// in place but are no longer imported or called here. Do not re-add them.
//
// Both layers build into ONE candidate list and go through ONE attempt loop
// (see SELECTION below) — they used to be two separate walks, which is how
// `task` came to be honoured on one and dropped on the other. The registry
// stays ADDITIVE: an account with zero providers configured contributes no
// candidates and the ladder runs exactly as it did. Ask Zo runs on the user's
// Claude subscription: with the Zo default model set to Haiku it is accurate
// on structured extraction, but it is measured slow (p50 35.6s) next to
// OpenRouter (p50 8.2s), which is why the seed order and the live
// latency-reordered order both put OpenRouter ahead of it. To pin a specific
// model for this app regardless of the Zo account default, set ZOASK_MODEL to
// a `byok:` id. Each tier is
// skipped when unconfigured; on any error/timeout we catch and fall through.
// If every tier fails (or none are configured), the last error is re-thrown.
// Independent tiers exist specifically so a single provider's outage or
// stale credential can never take the assistant down completely — verified
// live on 2026-08-18 when Ask Zo (timeout), OpenCode (billing), and NIM
// (stale key) all failed at once with no working fallback left.
// Image generation is a separate ladder — see ./image-router.

import type { ChatMessage } from './opencode';
import { withUsageCapture, type TokenUsage, type UsageStatus, type UsageSource } from './usage';
import { orderByHealth, recordSuccess, recordFailure, healthSnapshot, classifyFailure } from './health';
import { filterEligible, estimateTokens, type CallSize } from './eligibility';
import * as opencode from './opencode';
import { zoAskConfigured, zoAskText, zoAskChat } from './zoask';
import { openrouterConfigured, openrouterText, openrouterChat, openrouterStreamChat } from './openrouter';
import { log } from '@/lib/logger';
import { registryConfigured, resolveChain, resolveChainForTask, callModel, callModelStream, type ResolvedModel } from './providers';
import { isPastDeadline, deadlineExceededError } from './deadline';

// ─────────────────────────────────────────────────────────────────────────────
// LADDER ORDER
// ─────────────────────────────────────────────────────────────────────────────
// The order below was hardcoded, and a live probe showed why that is a problem:
//
//   zoask       ok   22,718ms   <- tried FIRST
//   opencode    401       91ms
//   nim         ok        413ms
//   openrouter  ok        770ms
//
// Ask Zo answers correctly but ~55x slower than a fast tier, and it sat first,
// so every call paid 22s before a fast tier was ever reached. The agent loop makes up to
// MAX_STEPS (10) model calls per run — that is the difference between a run
// finishing in ~4s and one taking almost four minutes.
//
// Order is now data, not control flow. AI_TIER_ORDER (comma-separated) lets the
// operator reorder without a deploy, which matters because the RIGHT order is an
// empirical fact that changes: quota runs out, a provider slows down, a key is
// rotated. Run POST /api/admin/ai-probe to measure, then set this.
//
// Unknown names are ignored and any tier missing from the list is appended in
// its default position, so a typo degrades to today's behaviour instead of
// silently disabling a tier.
//
// OPENROUTER MOVED BACK TO FIRST, 2026-08-31 — correcting the PR #8 reorder
// above (which had put opencode ahead of openrouter). PR #8 read OpenRouter as
// "out of credit" from twelve 402s in one incident; that reading was wrong.
// Queried against PRODUCTION `ai_usage`, last 48h, successful calls only:
//
//   tier         calls ok   p50 latency   p90 latency    worst        failures
//   zoask        77         35,621ms      64,867ms       109,044ms    15 (timeouts)
//   openrouter   66          8,233ms      24,239ms       140,163ms    0 logged
//
// (openrouter's ALL-TIME average latency in ai_usage is ~142,756ms — do not
// cite that figure as current behaviour, it includes an earlier era of
// failures and calls that ran into the old ~300s deadline; the 8,233ms
// figure above, the last-48h p50 over successful calls, is what describes
// OpenRouter today.)
//
// OpenRouter is not out of credit — it 402s on two chain models
// (anthropic/claude-haiku-4.5, openai/gpt-5.6-luna) and succeeds on a third
// (openai/gpt-oss-120b), 66 times in this window. It is also the fastest
// PROVEN tier: 4.3x faster than zoask's p50, and clearly faster than
// opencode's registry route (below), so this constant seeds fastest-first:
// openrouter, zoask, opencode.
//
// OPENCODE'S TRUE STATE (queried separately, full ai_usage history, since the
// 48h window this file otherwise cites has zero opencode calls in it — the
// hardcoded tier's key died 2026-08-28 and nothing has retried it since).
// There are two distinct paths and they tell different stories:
//   - The HARDCODED `opencode` tier used directly by this file (ai_usage rows
//     with provider_id NULL, model_label 'opencode'): 21 calls, ALL FAILED
//     "OpenCode failed (401)", avg 101ms, window 2026-08-27 to 2026-08-28
//     13:45, nothing since. This is a DEAD key, not merely an untested one —
//     health.ts's 'auth' classification parks it permanently until an
//     operator rotates the credential.
//   - The REGISTRY path (an ai_models row reached via resolveChainForTask,
//     only for accounts with ai_routing configured — a different code path
//     than this file's hardcoded ladder, see the two-layer note at the top of
//     this file): "DeepSeek V4 Flash (paid)" — 152 SUCCESSFUL calls, 1
//     failure (empty response), window 2026-08-28 to 2026-08-29, avg latency
//     46,112ms. OpenCode's DeepSeek genuinely works through the registry —
//     it is simply the SLOWEST measured path of the three (46.1s vs zoask's
//     ~43.7s all-time average and openrouter's 8.2s recent p50). So opencode
//     is seeded last here on measured speed (and its hardcoded tier's key
//     being dead), not on an assumption that nobody has tried it.
//
// zoask sat FIRST in the order this constant is replacing, at a 35.6s p50 —
// four steps at its own p90 is 260s, inside the 270s turn deadline with zero
// margin, and a production turn actually died at 300,005ms after two steps
// during the incident that prompted this fix.
//
// THIS CONSTANT IS NOW ONLY THE COLD-START SEED, not the decision. Since
// 2026-08-31, ./health's HEALTH_REORDER defaults ON: orderByHealth sorts the
// HEALTHY candidates by measured rolling latency (ewmaMs) on every call, so
// once a process has made a few calls the live order tracks reality rather
// than this hardcoded guess. This array only matters before anything has been
// measured (a cold process, or AI_HEALTH_REORDER=0 restoring the pure static
// order) — get the seed right so a cold start doesn't pay zoask's 35s median
// before the first measurement exists to correct it.
//
// If any tier's latency or credit status changes again, re-run
// POST /api/admin/ai-probe to measure, and update this order (and this
// comment) from what it actually measures — this comment documents the
// reasoning as of the date above, not a permanent law; a stale comment here
// is worse than none.
export const DEFAULT_TIER_ORDER = ['openrouter', 'zoask', 'opencode'] as const;
type TierName = (typeof DEFAULT_TIER_ORDER)[number];

export function tierOrder(): TierName[] {
  const raw = (process.env.AI_TIER_ORDER || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const known = raw.filter((t): t is TierName => (DEFAULT_TIER_ORDER as readonly string[]).includes(t));
  const rest = DEFAULT_TIER_ORDER.filter((t) => !known.includes(t));
  return [...known, ...rest];
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────────────────────
// The circuit breaker that used to live here moved to ./health, re-keyed from
// the TIER to the individual candidate. Same thresholds, same cooldown, same
// one-trial-call recovery — see that file for why the numbers are what they
// are. What it fixes: "openrouter" is one key in front of ~17 models behind
// different upstreams, and one model's 429 was taking all seventeen offline.

/** Read-only snapshot for diagnostics (see /api/admin/ai-probe).
 *
 *  Kept under its old name and old shape because the probe route and its UI
 *  read it; the rows are now per candidate rather than per tier, so a tier that
 *  used to appear once may appear as several model ids. `healthSnapshot()` in
 *  ./health carries the fuller picture including measured latency. */
export function breakerState(): Record<string, { fails: number; openFor: number }> {
  const out: Record<string, { fails: number; openFor: number }> = {};
  for (const row of healthSnapshot()) {
    if (!row.consecutiveFails && !row.heldForMs) continue;
    out[row.candidate] = { fails: row.consecutiveFails, openFor: row.heldForMs };
  }
  return out;
}

/** Reorder the ladder for a 'heavy' call: Ask Zo (the user's Claude
 *  subscription) goes first regardless of the operator's measured-latency
 *  order, because it's the one tier that is both the highest-quality model
 *  AND has real live web access (a genuine Zo agent session — see zoask.ts).
 *  A task marked heavy is explicitly trading latency for a better answer, so
 *  optimizing its ladder for speed would silently undo that tradeoff.
 *  'fast'/'balanced'/unset all return the operator's configured order
 *  untouched — reordering is opt-in per call, not a blanket behavior change. */
function orderForTier(preferTier?: 'fast' | 'balanced' | 'heavy'): TierName[] {
  const base = tierOrder();
  if (preferTier !== 'heavy') return base;
  return ['zoask', ...base.filter((t) => t !== 'zoask')];
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECTION
// ─────────────────────────────────────────────────────────────────────────────
// ONE list, ONE attempt loop. This replaces two code paths — tryRegistry, which
// walked the account's configured models, and runLadder, which walked the
// hardcoded tiers — that were tried in sequence and had drifted apart in ways
// that mattered:
//
//   * `task` reached the registry path and was DROPPED on the ladder. Whenever
//     the registry returned nothing, task-aware routing silently stopped
//     existing, with nothing to indicate it had.
//   * Only the registry path called logUsage. Anything answered by the ladder
//     never reached ai_usage at all, so the Usage panel was reporting on a
//     subset of calls while reading as if it covered them all.
//   * The breaker existed on the ladder only, so a dead registry model was
//     attempted, and paid its timeout, on every single call.
//
// Every one of those is the same bug: two places deciding one thing. A
// candidate is now whatever the selector will actually attempt — an account's
// model row, or a ladder tier whose client owns its own internal chain — and
// they go through the same ordering, the same health accounting and the same
// logging.

interface Candidate {
  /** Health key. Stable across calls and unique per attemptable thing. */
  id: string;
  /** Human-readable, for logs and for the ai_usage row. */
  label: string;
  /** Present for registry candidates; absent for ladder tiers, which have no
   *  ai_models row to point at. */
  resolved?: ResolvedModel;
  run: () => Promise<string>;
}

/** Provider hint fed to health.ts's classifyFailure/resetPeriodFor, so a
 *  quota_exhausted candidate parks against ITS provider's reset period (see
 *  AI_QUOTA_RESET_PERIOD_<PROVIDER>) rather than the global default. A ladder
 *  tier's id already IS its provider name ('huggingface', 'openrouter', …);
 *  a registry candidate has no such name, so its provider's `kind` column
 *  (the closest thing it has) stands in instead. */
function providerHint(candidate: Candidate): string | undefined {
  return candidate.resolved?.provider.kind ?? candidate.id;
}

/** Best-effort usage logging; imported lazily inside the try so a circular
 *  import or a credits.ts failure can never break AI generation itself. */
async function logUsage(entry: {
  accountId: string; candidate: Candidate; kind: 'text' | 'chat'; ok: boolean; error?: string; latencyMs: number;
  usage?: TokenUsage | null;
  // Absent on the failure path (a candidate that threw before its capture
  // scope produced a classification) — recordAiUsage treats absence as
  // not_attempted/none, which is the honest read: no capture happened.
  usageStatus?: UsageStatus;
  usageSource?: UsageSource;
  // Same absence rule, same reason, for provider-reported timing (migration
  // 078) — distinct from `latencyMs` above, which is OUR wrapper's elapsed
  // clock and is always present.
  timingMs?: number | null;
  timingStatus?: UsageStatus;
  timingSource?: UsageSource;
  conversationId?: string;
}): Promise<string | null> {
  try {
    const { recordAiUsage } = await import('@/lib/credits');
    return await recordAiUsage({
      conversationId: entry.conversationId ?? null,
      accountId: entry.accountId,
      // Null for a ladder tier — it is not one of the account's configured
      // models and pointing the row at one would misattribute it.
      providerId: entry.candidate.resolved?.provider.id ?? null,
      modelId: entry.candidate.resolved?.model.id ?? null,
      modelLabel: entry.candidate.label,
      kind: entry.kind,
      ok: entry.ok,
      error: entry.error,
      latencyMs: entry.latencyMs,
      // NULL, not 0, when the tier reported nothing — see lib/ai/usage.ts.
      tokensIn: entry.usage?.tokensIn ?? null,
      tokensOut: entry.usage?.tokensOut ?? null,
      usageStatus: entry.usageStatus ?? 'not_attempted',
      usageSource: entry.usageSource ?? 'none',
      providerLatencyMs: entry.timingMs ?? null,
      timingStatus: entry.timingStatus ?? 'not_attempted',
      timingSource: entry.timingSource ?? 'none',
    });
  } catch { return null; /* logging must never break the caller */ }
}

/** The account's configured chain, or [] when it has none. Never throws —
 *  a registry lookup failing must degrade to the ladder, not to an error. */
async function registryCandidates(
  accountId: string | undefined,
  modelId: string | undefined,
  task: string | undefined,
  preferTier: 'fast' | 'balanced' | 'heavy' | undefined,
  call: (resolved: ResolvedModel) => Promise<string>,
): Promise<Candidate[]> {
  if (!accountId) return [];
  if (!(await registryConfigured(accountId).catch(() => false))) return [];
  const chain = task
    ? await resolveChainForTask(accountId, task, { preferTier }).catch(() => [])
    : await resolveChain(accountId, { modelId }).catch(() => []);
  return chain.map((resolved) => ({
    id: `model:${resolved.model.id}`,
    label: resolved.model.label || resolved.model.model_id,
    resolved,
    run: () => call(resolved),
  }));
}

/** The hardcoded tiers, in the operator's configured order, skipping any that
 *  are unconfigured. */
function ladderCandidates(
  runners: Partial<Record<TierName, { configured: boolean; run: () => Promise<string> }>>,
  preferTier?: 'fast' | 'balanced' | 'heavy',
): Candidate[] {
  const out: Candidate[] = [];
  for (const tier of orderForTier(preferTier)) {
    const r = runners[tier];
    if (!r || !r.configured) continue;
    out.push({ id: tier, label: tier, run: r.run });
  }
  return out;
}

/**
 * Try candidates in health order and return the first answer.
 *
 * Ordering is: the account's configured models, then the hardcoded tiers, with
 * anything currently quarantined moved to the back of the whole list rather
 * than removed. Holding back is a latency optimisation, never a refusal — if
 * every candidate is unhealthy the call still goes out, it just goes out last.
 *
 * Throws the LAST error, matching what both replaced paths did. A caller
 * seeing "OpenRouter failed (404)" is being told what the final attempt hit,
 * not what the first one did.
 */
/** Optional observability threading (migration 060). Absent for every caller
 *  that predates it, so those calls behave exactly as before.
 *
 *  `onUsageRow` hands the caller the ai_usage row id for the attempt that
 *  ANSWERED, so it can later record whether the response was actually usable
 *  (markParseOutcome). It is invoked off a fire-and-forget write, so on a fast
 *  turn a caller may reach its parse step before the id arrives — that
 *  undercounts, it never miscounts. Closing that race would mean awaiting a DB
 *  round-trip inside every model call, which is not worth it. */
interface UsageTrace {
  conversationId?: string;
  onUsageRow?: (id: string) => void;
  /** Absolute epoch-ms deadline for the whole turn this call belongs to.
   *  Optional/additive — see lib/ai/deadline.ts. When set, runCandidates
   *  stops trying further candidates once it has passed, rather than
   *  starting an attempt that cannot finish in time. */
  deadlineAt?: number;
}

async function runCandidates(
  fn: string,
  candidates: Candidate[],
  accountId: string | undefined,
  kind: 'text' | 'chat',
  size: CallSize,
  trace?: UsageTrace,
): Promise<string> {
  // Eligibility BEFORE health, because they answer different kinds of question.
  // Health is a preference and can be overruled by circumstance; capability
  // cannot — a 32k model does not become able to read a 60k prompt because
  // everything else is down. Never returns empty; see filterEligible.
  const eligible = filterEligible(
    candidates,
    (c) => c.resolved?.model,
    size,
    // log.info() is console-only and never persisted (lib/logger.ts) — a
    // candidate excluded before it is ever tried left no durable trace, which
    // made it impossible to tell "eligibility filtered out the paid models"
    // from "the paid models were never tried" after the fact. log.request()
    // is the existing channel that already persists info-level rows (see
    // commit 8363657, which fixed the identical problem for the concurrency
    // counters) — reused here rather than inventing a new persistence path.
    // Still 'info', not 'warn': being ineligible is normal operation for a
    // candidate whose capacity doesn't fit this call, not a warning.
    (c, reason) => log.request({ message: 'ai router: candidate not eligible', detail: { fn, candidate: c.id, reason, model: c.resolved?.model.model_id } }, 'info'),
  );

  let lastErr: any = null;
  for (const candidate of orderByHealth(eligible, (c) => c.id)) {
    // Checked BEFORE every candidate, not just the ones that come from a
    // provider's own internal chain: a deadline that has already passed
    // means the next candidate cannot finish, so it must not be started at
    // all. This is the one place that sees the WHOLE candidate list (registry
    // rows + ladder tiers), so it is where "stop trying further candidates"
    // has to live regardless of which layer contributed them. Distinct error
    // (not lastErr) so a deadline exhaustion is never read as an ordinary
    // provider failure in app_logs — see lib/ai/deadline.ts.
    if (isPastDeadline(trace?.deadlineAt)) {
      log.warn('ai router: turn deadline exceeded, stopping candidate attempts', {
        fn, remainingCandidates: eligible.length,
      });
      throw deadlineExceededError(fn, lastErr);
    }
    const start = Date.now();
    // One capture scope per attempt, so a failed model's usage block cannot be
    // attributed to the model that answered after it.
    try {
      const {
        result: text, usage, status: usageStatus, source: usageSource,
        timingMs, timingStatus, timingSource,
      } = await withUsageCapture(candidate.run);
      const latencyMs = Date.now() - start;
      // An empty answer is a failure of this candidate, not a result. The old
      // registry path fell through on it silently; now it is recorded as the
      // failure it is, so a model that always returns nothing shows up.
      if (!text) {
        // Name the model, not just the tier: "openrouter returned an empty
        // response" is useless when the tier is a fallback chain of ~17
        // models and nothing else says which one answered blank. Registry
        // candidates (one Candidate per ai_models row) carry `resolved`, so
        // this is populated for those; a hardcoded ladder tier (openrouter,
        // zoask, opencode) has no `resolved` and degrades to the unqualified
        // message rather than printing the literal string "undefined".
        const model = candidate.resolved?.model.model_id;
        throw new Error(`${candidate.label} returned an empty response${model ? ` (model=${model})` : ''}`);
      }
      recordSuccess(candidate.id, latencyMs);
      // Still ok:true — the transport DID succeed, and that is the only thing
      // this layer can honestly assert. Whether the text was USABLE is a
      // separate fact the caller learns later and reports via parse_ok; before
      // migration 060 the two were the same column, so a model answering in
      // prose was indistinguishable from a real success.
      if (accountId) {
        void logUsage({
          accountId, candidate, kind, ok: true, latencyMs, usage, usageStatus, usageSource,
          timingMs, timingStatus, timingSource, conversationId: trace?.conversationId,
        })
          .then((id) => { if (id) trace?.onUsageRow?.(id); });
      }
      log.info('ai router: candidate answered', { fn, candidate: candidate.id, latencyMs });
      return text;
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      recordFailure(candidate.id, classifyFailure(err, providerHint(candidate)));
      if (accountId) {
        void logUsage({
          accountId, candidate, kind, ok: false,
          error: String(err?.message || err).slice(0, 300), latencyMs,
          conversationId: trace?.conversationId,
        });
      }
      // `model` is additive and separate from the prose `error` string: a model
      // id embedded only in that string cannot be grouped by in SQL (detail
      // ->> 'model' can; detail->>'error' full-text can't). Undefined for
      // ladder-tier candidates, which have no `resolved` — see the empty-
      // response check above.
      log.warn('ai router: candidate failed', {
        fn, candidate: candidate.id, error: String(err?.message || err),
        model: candidate.resolved?.model.model_id,
      });
      lastErr = err;
    }
  }
  throw lastErr || new Error('No AI tier configured');
}

export type { ChatMessage };

export function textConfigured(): boolean {
  return zoAskConfigured() || opencode.opencodeConfigured() || openrouterConfigured();
}

export async function generateText(opts: {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
  /** Server-derived account id (never client-supplied). When set AND the
   *  account has a configured provider registry, that chain is tried first. */
  accountId?: string;
  /** Specific ai_models.id to try before the account's active/fallback chain. */
  modelId?: string;
  /** agent_conversations.id to stamp on the ai_usage row (migration 060). */
  conversationId?: string;
  /** Receives the ai_usage row id of the attempt that answered, so the caller
   *  can record whether the response was usable. See UsageTrace. */
  onUsageRow?: (id: string) => void;
  /** Absolute epoch-ms deadline for the whole turn this call belongs to.
   *  Optional/additive: a caller that omits it gets byte-identical
   *  (unbounded) behaviour. See lib/ai/deadline.ts. */
  deadlineAt?: number;
}): Promise<string> {
  const registry = await registryCandidates(opts.accountId, opts.modelId, undefined, undefined, (resolved) =>
    callModel(resolved, { system: opts.system, prompt: opts.prompt, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens }),
  );
  const ladder = ladderCandidates({
    zoask: { configured: zoAskConfigured(), run: () => zoAskText({ system: opts.system, prompt: opts.prompt, maxOutputTokens: opts.maxOutputTokens, deadlineAt: opts.deadlineAt }) },
    opencode: { configured: opencode.opencodeConfigured(), run: () => opencode.generateText(opts) },
    openrouter: { configured: openrouterConfigured(), run: () => openrouterText(opts) },
  });
  return runCandidates('generateText', [...registry, ...ladder], opts.accountId, 'text', {
    promptTokens: estimateTokens((opts.system || '') + opts.prompt),
    wantOutputTokens: opts.maxOutputTokens,
  },
    { conversationId: opts.conversationId, onUsageRow: opts.onUsageRow, deadlineAt: opts.deadlineAt },
  );
}

export async function generateChat(opts: {
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
  /** Per-call Zo Ask model override (byok id). Lets latency-sensitive callers
   *  (e.g. the agent loop) pin a fast tier without changing the global default. */
  zoAskModel?: string;
  /** Server-derived account id (never client-supplied). When set AND the
   *  account has a configured provider registry, that chain is tried first. */
  accountId?: string;
  /** Specific ai_models.id to try before the account's active/fallback chain. */
  modelId?: string;
  /** agent_conversations.id to stamp on the ai_usage row (migration 060). */
  conversationId?: string;
  /** Receives the ai_usage row id of the attempt that answered, so the caller
   *  can record whether the response was usable. See UsageTrace. */
  onUsageRow?: (id: string) => void;
  /** Task hint (Packet 8.1) — prefers models tagged `good` for this task, e.g.
   *  'draft' for the compose pass. Reorders the chain; never excludes. */
  task?: string;
  /** Preferred tier for the task, e.g. 'heavy' for user-facing prose. */
  preferTier?: 'fast' | 'balanced' | 'heavy';
  /** Omit maxOutputTokens and set this to say "use the selected model's own
   *  output capability, but no more than this" (migration 038). */
  maxOutputCeiling?: number;
  /** Absolute epoch-ms deadline for the whole turn this call belongs to.
   *  Optional/additive: a caller that omits it gets byte-identical
   *  (unbounded) behaviour. See lib/ai/deadline.ts. */
  deadlineAt?: number;
}): Promise<string> {
  const registry = await registryCandidates(opts.accountId, opts.modelId, opts.task, opts.preferTier, (resolved) =>
    callModel(resolved, { system: opts.system, messages: opts.messages, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, maxOutputCeiling: opts.maxOutputCeiling }),
  );
  const ladder = ladderCandidates({
    zoask: { configured: zoAskConfigured(), run: () => zoAskChat({ system: opts.system, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens, model: opts.zoAskModel, deadlineAt: opts.deadlineAt }) },
    opencode: { configured: opencode.opencodeConfigured(), run: () => opencode.generateChat(opts) },
    openrouter: { configured: openrouterConfigured(), run: () => openrouterChat(opts) },
  }, opts.preferTier);
  return runCandidates('generateChat', [...registry, ...ladder], opts.accountId, 'chat', {
    promptTokens: estimateTokens((opts.system || '') + opts.messages.map((m) => m.content).join('')),
    // maxOutputCeiling is deliberately NOT passed: it means "the model's own
    // capability, but no more than this", so a model under the ceiling is
    // satisfying the request rather than failing it.
    wantOutputTokens: opts.maxOutputTokens,
  },
    { conversationId: opts.conversationId, onUsageRow: opts.onUsageRow, deadlineAt: opts.deadlineAt },
  );
}

/**
 * Streaming twin of `generateChat` (Packet 8.1c). Pure addition — `generateChat`
 * is untouched.
 *
 * Builds the SAME candidate list as `generateChat` — the account's configured
 * chain (honouring `task`/`preferTier`) followed by the hardcoded tiers — and
 * runs it through the same selector. Errors behave identically: a failing
 * candidate falls through to the next, and if every one fails the last error is
 * thrown.
 *
 * Resolves with the COMPLETE text, exactly as `generateChat` would. Tiers that
 * cannot stream (Zo Ask, Gemini) invoke `onDelta` exactly once with the whole
 * answer, so the caller never has to know which kind it got.
 *
 * IMPORTANT — deltas are a PROGRESSIVE PREVIEW, not the truth. A tier can emit
 * some deltas and THEN fail, at which point we fall through to the next tier and
 * the already-emitted text is stale. Un-emitting it is impossible on a live
 * stream, so the contract is the other way round: the caller MUST treat the
 * returned string (and, downstream, the `final` event's `message`) as
 * authoritative and OVERWRITE anything it accumulated from deltas.
 */
export async function streamChat(
  opts: Parameters<typeof generateChat>[0],
  onDelta: (chunk: string) => void,
): Promise<string> {
  const registry = await registryCandidates(opts.accountId, opts.modelId, opts.task, opts.preferTier, (resolved) =>
    callModelStream(resolved, { system: opts.system, messages: opts.messages, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, maxOutputCeiling: opts.maxOutputCeiling }, onDelta),
  );
  const ladder = ladderCandidates({
    zoask: { configured: zoAskConfigured(), run: () => zoAskChat({ system: opts.system, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens, model: opts.zoAskModel, deadlineAt: opts.deadlineAt }) },
    opencode: { configured: opencode.opencodeConfigured(), run: () => opencode.streamChat(opts, onDelta) },
    openrouter: { configured: openrouterConfigured(), run: () => openrouterStreamChat(opts, onDelta) },
  }, opts.preferTier);
  return runCandidates('streamChat', [...registry, ...ladder], opts.accountId, 'chat', {
    promptTokens: estimateTokens((opts.system || '') + opts.messages.map((m) => m.content).join('')),
    // maxOutputCeiling is deliberately NOT passed: it means "the model's own
    // capability, but no more than this", so a model under the ceiling is
    // satisfying the request rather than failing it.
    wantOutputTokens: opts.maxOutputTokens,
  },
    { conversationId: opts.conversationId, onUsageRow: opts.onUsageRow, deadlineAt: opts.deadlineAt },
  );
}

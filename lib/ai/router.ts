// AI routing ladder — drop-in replacement for OpenCode's public text API.
//
// Two layers, tried in order:
//   0. Configurable registry (lib/ai/providers.ts) — ONLY consulted when the
//      caller passes `accountId` AND that account has rows in ai_routing
//      (migration 023). Per-account providers + active/fallback chain,
//      configured from Settings -> Models. Every call is logged to ai_usage.
//   1. Hardcoded ladder (unchanged from before this file existed):
//      1. Ask Zo  (user's Claude subscription — Haiku when set as the Zo account
//         default model; billed to the user's own Anthropic subscription)
//      2. OpenCode Go (deepseek-v4-pro — fast + accurate; used when Ask Zo fails)
//      3. NVIDIA NIM (free tier, weaker instruction-following)
//      4. OpenRouter (last resort — free models, deepseek-v4-flash as final fallback)
//
// This makes the registry ADDITIVE and backward-compatible: an account with
// zero providers configured (i.e. every account today) skips step 0 entirely
// and behaves EXACTLY as before. Ask Zo is first in the hardcoded ladder
// because it runs on the user's Claude subscription: with the Zo default
// model set to Haiku it is fast AND accurate on structured extraction. If the
// subscription tier errors/times out we fall through to OpenCode Go, then to
// NIM, then to OpenRouter. To pin a specific model for this app regardless of
// the Zo account default, set ZOASK_MODEL to a `byok:` id. Each tier is
// skipped when unconfigured; on any error/timeout we catch and fall through.
// If every tier fails (or none are configured), the last error is re-thrown.
// Four independent tiers exist specifically so a single provider's outage or
// stale credential can never take the assistant down completely — verified
// live on 2026-08-18 when Ask Zo (timeout), OpenCode (billing), and NIM
// (stale key) all failed at once with no working fallback left.
// Image generation is a separate ladder — see ./image-router.

import type { ChatMessage } from './opencode';
import * as opencode from './opencode';
import { zoAskConfigured, zoAskText, zoAskChat } from './zoask';
import { nimConfigured, nimText, nimChat, nimStreamChat } from './nim';
import { huggingfaceConfigured, hfText, hfChat, hfStreamChat } from './huggingface';
import { openrouterConfigured, openrouterText, openrouterChat, openrouterStreamChat } from './openrouter';
import { log } from '@/lib/logger';
import { registryConfigured, resolveChain, resolveChainForTask, callModel, callModelStream, type ResolvedModel } from './providers';

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
// Ask Zo answers correctly but ~55x slower than NIM, and it sat first, so every
// call paid 22s before a fast tier was ever reached. The agent loop makes up to
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
const DEFAULT_TIER_ORDER = ['zoask', 'opencode', 'nim', 'huggingface', 'openrouter'] as const;
type TierName = (typeof DEFAULT_TIER_ORDER)[number];

function tierOrder(): TierName[] {
  const raw = (process.env.AI_TIER_ORDER || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const known = raw.filter((t): t is TierName => (DEFAULT_TIER_ORDER as readonly string[]).includes(t));
  const rest = DEFAULT_TIER_ORDER.filter((t) => !known.includes(t));
  return [...known, ...rest];
}

/** Walk the tiers in configured order, logging which one answered and why the
 *  others declined. Returns the first successful result. */
async function runLadder(
  fn: string,
  runners: Partial<Record<TierName, { configured: boolean; run: () => Promise<string> }>>,
): Promise<{ text?: string; lastErr: any }> {
  let lastErr: any = null;
  for (const tier of tierOrder()) {
    const r = runners[tier];
    if (!r || !r.configured) continue;
    try {
      const text = await r.run();
      log.info('ai router: tier succeeded', { tier, fn });
      return { text, lastErr: null };
    } catch (err: any) {
      log.warn('ai router: tier failed', { tier, error: String(err?.message || err) });
      lastErr = err;
    }
  }
  return { lastErr };
}


export type { ChatMessage };

export function textConfigured(): boolean {
  return zoAskConfigured() || opencode.opencodeConfigured() || nimConfigured() || huggingfaceConfigured() || openrouterConfigured();
}

// Best-effort usage logging; imported lazily inside the try so a circular
// import or a credits.ts failure can never break AI generation itself.
async function logUsage(entry: {
  accountId: string; resolved: ResolvedModel; kind: 'text' | 'chat'; ok: boolean; error?: string; latencyMs: number;
}): Promise<void> {
  try {
    const { recordAiUsage } = await import('@/lib/credits');
    await recordAiUsage({
      accountId: entry.accountId,
      providerId: entry.resolved.provider.id,
      modelId: entry.resolved.model.id,
      modelLabel: entry.resolved.model.label || entry.resolved.model.model_id,
      kind: entry.kind,
      ok: entry.ok,
      error: entry.error,
      latencyMs: entry.latencyMs,
    });
  } catch { /* logging must never break the caller */ }
}

/** Try the account's configured registry chain; returns null (never throws)
 * when unconfigured or when every configured tier fails, so callers fall
 * through to the hardcoded ladder unchanged. */
async function tryRegistry(
  accountId: string | undefined,
  modelId: string | undefined,
  kind: 'text' | 'chat',
  call: (resolved: ResolvedModel) => Promise<string>,
  // Task hint (Packet 8.1). When present, models tagged `good` for this task are
  // tried first. Reordering only — a roster with no tags resolves exactly as
  // before, so this stays a pure addition.
  task?: string,
  preferTier?: 'fast' | 'balanced' | 'heavy',
): Promise<string | null> {
  if (!accountId) return null;
  if (!(await registryConfigured(accountId).catch(() => false))) return null;
  const chain = task
    ? await resolveChainForTask(accountId, task, { preferTier }).catch(() => [])
    : await resolveChain(accountId, { modelId }).catch(() => []);
  for (const resolved of chain) {
    const start = Date.now();
    try {
      const text = await call(resolved);
      void logUsage({ accountId, resolved, kind, ok: true, latencyMs: Date.now() - start });
      if (text) return text;
    } catch (err: any) {
      void logUsage({ accountId, resolved, kind, ok: false, error: String(err?.message || err).slice(0, 300), latencyMs: Date.now() - start });
    }
  }
  return null;
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
}): Promise<string> {
  const registryResult = await tryRegistry(opts.accountId, opts.modelId, 'text', (resolved) =>
    callModel(resolved, { system: opts.system, prompt: opts.prompt, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens }),
  );
  if (registryResult) return registryResult;


  const ladder = await runLadder('generateText', {
      zoask: { configured: zoAskConfigured(), run: () => zoAskText({ system: opts.system, prompt: opts.prompt, maxOutputTokens: opts.maxOutputTokens }) },
      opencode: { configured: opencode.opencodeConfigured(), run: () => opencode.generateText(opts) },
      nim: { configured: nimConfigured(), run: () => nimText(opts) },
      huggingface: { configured: huggingfaceConfigured(), run: () => hfText(opts) },
      openrouter: { configured: openrouterConfigured(), run: () => openrouterText(opts) },
    });
  if (ladder.text !== undefined) return ladder.text;
  const lastErr = ladder.lastErr;
  throw lastErr || new Error('No AI tier configured');
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
  /** Task hint (Packet 8.1) — prefers models tagged `good` for this task, e.g.
   *  'draft' for the compose pass. Reorders the chain; never excludes. */
  task?: string;
  /** Preferred tier for the task, e.g. 'heavy' for user-facing prose. */
  preferTier?: 'fast' | 'balanced' | 'heavy';
  /** Omit maxOutputTokens and set this to say "use the selected model's own
   *  output capability, but no more than this" (migration 038). */
  maxOutputCeiling?: number;
}): Promise<string> {
  const registryResult = await tryRegistry(opts.accountId, opts.modelId, 'chat', (resolved) =>
    callModel(resolved, { system: opts.system, messages: opts.messages, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, maxOutputCeiling: opts.maxOutputCeiling }),
    opts.task, opts.preferTier,
  );
  if (registryResult) return registryResult;

  const ladder = await runLadder('generateChat', {
      zoask: { configured: zoAskConfigured(), run: () => zoAskChat({ system: opts.system, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens, model: opts.zoAskModel }) },
      opencode: { configured: opencode.opencodeConfigured(), run: () => opencode.generateChat(opts) },
      nim: { configured: nimConfigured(), run: () => nimChat(opts) },
      huggingface: { configured: huggingfaceConfigured(), run: () => hfChat(opts) },
      openrouter: { configured: openrouterConfigured(), run: () => openrouterChat(opts) },
    });
  if (ladder.text !== undefined) return ladder.text;
  const lastErr = ladder.lastErr;
  throw lastErr || new Error('No AI tier configured');
}

/**
 * Streaming twin of `generateChat` (Packet 8.1c). Pure addition — `generateChat`
 * is untouched.
 *
 * Tries the SAME layers in the SAME order as `generateChat`: the registry chain
 * first (honouring `task`/`preferTier` via `resolveChainForTask`, and
 * `accountId`/`modelId`) through the shared `tryRegistry` helper, then the
 * hardcoded Zo Ask -> OpenCode -> NIM ladder. Errors behave identically: a
 * failing tier falls through to the next, and if every tier fails the last
 * error is thrown.
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
  const registryResult = await tryRegistry(opts.accountId, opts.modelId, 'chat', (resolved) =>
    callModelStream(resolved, { system: opts.system, messages: opts.messages, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, maxOutputCeiling: opts.maxOutputCeiling }, onDelta),
    opts.task, opts.preferTier,
  );
  if (registryResult) return registryResult;

  const ladder = await runLadder('streamChat', {
      zoask: { configured: zoAskConfigured(), run: () => zoAskChat({ system: opts.system, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens, model: opts.zoAskModel }) },
      opencode: { configured: opencode.opencodeConfigured(), run: () => opencode.streamChat(opts, onDelta) },
      nim: { configured: nimConfigured(), run: () => nimStreamChat(opts, onDelta) },
      huggingface: { configured: huggingfaceConfigured(), run: () => hfStreamChat(opts, onDelta) },
      openrouter: { configured: openrouterConfigured(), run: () => openrouterStreamChat(opts, onDelta) },
    });
  if (ladder.text !== undefined) return ladder.text;
  const lastErr = ladder.lastErr;
  throw lastErr || new Error('No AI tier configured');
}

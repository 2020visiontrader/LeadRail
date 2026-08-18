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
//      3. NVIDIA NIM (last resort — free tier, weaker instruction-following)
//
// This makes the registry ADDITIVE and backward-compatible: an account with
// zero providers configured (i.e. every account today) skips step 0 entirely
// and behaves EXACTLY as before. Ask Zo is first in the hardcoded ladder
// because it runs on the user's Claude subscription: with the Zo default
// model set to Haiku it is fast AND accurate on structured extraction. If the
// subscription tier errors/times out we fall through to OpenCode Go, then to
// NIM. To pin a specific model for this app regardless of the Zo account
// default, set ZOASK_MODEL to a `byok:` id. Each tier is skipped when
// unconfigured; on any error/timeout we catch and fall through. If every tier
// fails (or none are configured), the last error is re-thrown.
// Image generation stays on Gemini.

import type { ChatMessage } from './opencode';
import * as opencode from './opencode';
import { zoAskConfigured, zoAskText, zoAskChat } from './zoask';
import { nimConfigured, nimText, nimChat, nimStreamChat } from './nim';
import { log } from '@/lib/logger';
import { registryConfigured, resolveChain, resolveChainForTask, callModel, callModelStream, type ResolvedModel } from './providers';

export type { ChatMessage };

export function textConfigured(): boolean {
  return zoAskConfigured() || opencode.opencodeConfigured() || nimConfigured();
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

  let lastErr: any = null;
  if (zoAskConfigured()) {
    try {
      return await zoAskText({ system: opts.system, prompt: opts.prompt, maxOutputTokens: opts.maxOutputTokens });
    } catch (err: any) {
      // Attribute the failure to its TIER before the next one overwrites
      // lastErr. Without this the ladder reports only the final tier's
      // error — a NIM 403 with no hint that Ask Zo and OpenCode were
      // tried first and why they declined.
      log.warn('ai router: tier failed', { tier: 'zoask', error: String(err?.message || err) });
      lastErr = err;
    }
  }
  if (opencode.opencodeConfigured()) {
    try {
      return await opencode.generateText(opts);
    } catch (err: any) {
      // Attribute the failure to its TIER before the next one overwrites
      // lastErr. Without this the ladder reports only the final tier's
      // error — a NIM 403 with no hint that Ask Zo and OpenCode were
      // tried first and why they declined.
      log.warn('ai router: tier failed', { tier: 'opencode', error: String(err?.message || err) });
      lastErr = err;
    }
  }
  if (nimConfigured()) {
    try {
      return await nimText(opts);
    } catch (err: any) {
      // Attribute the failure to its TIER before the next one overwrites
      // lastErr. Without this the ladder reports only the final tier's
      // error — a NIM 403 with no hint that Ask Zo and OpenCode were
      // tried first and why they declined.
      log.warn('ai router: tier failed', { tier: 'nim', error: String(err?.message || err) });
      lastErr = err;
    }
  }
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

  let lastErr: any = null;
  if (zoAskConfigured()) {
    try {
      return await zoAskChat({ system: opts.system, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens, model: opts.zoAskModel });
    } catch (err: any) {
      // Attribute the failure to its TIER before the next one overwrites
      // lastErr. Without this the ladder reports only the final tier's
      // error — a NIM 403 with no hint that Ask Zo and OpenCode were
      // tried first and why they declined.
      log.warn('ai router: tier failed', { tier: 'zoask', error: String(err?.message || err) });
      lastErr = err;
    }
  }
  if (opencode.opencodeConfigured()) {
    try {
      return await opencode.generateChat(opts);
    } catch (err: any) {
      // Attribute the failure to its TIER before the next one overwrites
      // lastErr. Without this the ladder reports only the final tier's
      // error — a NIM 403 with no hint that Ask Zo and OpenCode were
      // tried first and why they declined.
      log.warn('ai router: tier failed', { tier: 'opencode', error: String(err?.message || err) });
      lastErr = err;
    }
  }
  if (nimConfigured()) {
    try {
      return await nimChat(opts);
    } catch (err: any) {
      // Attribute the failure to its TIER before the next one overwrites
      // lastErr. Without this the ladder reports only the final tier's
      // error — a NIM 403 with no hint that Ask Zo and OpenCode were
      // tried first and why they declined.
      log.warn('ai router: tier failed', { tier: 'nim', error: String(err?.message || err) });
      lastErr = err;
    }
  }
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

  let lastErr: any = null;
  if (zoAskConfigured()) {
    try {
      // Zo Ask has no streaming transport — emit the whole answer as one delta.
      const text = await zoAskChat({ system: opts.system, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens, model: opts.zoAskModel });
      if (text) onDelta(text);
      return text;
    } catch (err: any) {
      // Attribute the failure to its TIER before the next one overwrites
      // lastErr. Without this the ladder reports only the final tier's
      // error — a NIM 403 with no hint that Ask Zo and OpenCode were
      // tried first and why they declined.
      log.warn('ai router: tier failed', { tier: 'zoask', error: String(err?.message || err) });
      lastErr = err;
    }
  }
  if (opencode.opencodeConfigured()) {
    try {
      return await opencode.streamChat(opts, onDelta);
    } catch (err: any) {
      // Attribute the failure to its TIER before the next one overwrites
      // lastErr. Without this the ladder reports only the final tier's
      // error — a NIM 403 with no hint that Ask Zo and OpenCode were
      // tried first and why they declined.
      log.warn('ai router: tier failed', { tier: 'opencode', error: String(err?.message || err) });
      lastErr = err;
    }
  }
  if (nimConfigured()) {
    try {
      return await nimStreamChat(opts, onDelta);
    } catch (err: any) {
      // Attribute the failure to its TIER before the next one overwrites
      // lastErr. Without this the ladder reports only the final tier's
      // error — a NIM 403 with no hint that Ask Zo and OpenCode were
      // tried first and why they declined.
      log.warn('ai router: tier failed', { tier: 'nim', error: String(err?.message || err) });
      lastErr = err;
    }
  }
  throw lastErr || new Error('No AI tier configured');
}

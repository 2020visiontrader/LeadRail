// Configurable AI provider/model registry (per account, DB-backed).
//
// This is the adclaw-style layer that sits ON TOP of the existing hardcoded
// ladder (zoask -> opencode -> nim), not a replacement for it. When an account
// has no rows in ai_providers/ai_routing, everything here is a no-op and
// lib/ai/router.ts behaves exactly as before. When an account HAS configured
// providers, resolveChain() returns an ordered list of runnable clients that
// router.ts tries first, falling back to the hardcoded ladder only if every
// configured tier fails.
//
// callModel() normalizes four upstream shapes behind one interface:
//   - openai-compatible (base_url + /chat/completions, Bearer key)
//   - anthropic (Messages API, x-api-key + anthropic-version)
//   - the existing zoask/opencode/nim/gemini clients (reused, not reimplemented)
//
// Keys are decrypted only in-process, only for the duration of a single call,
// and are NEVER logged (see lib/ai/crypto.ts). Reads via listProviders() mask
// the key.

import { supabase, dbReady } from '@/lib/db';
import { decryptSecret, encryptSecret, maskSecret, vaultConfigured } from './crypto';
import * as opencode from './opencode';
import { zoAskConfigured, zoAskText, zoAskChat } from './zoask';
import { nimConfigured, nimText, nimChat, nimStreamChat } from './nim';
import * as gemini from './gemini';
import { reportOpenAIUsage } from './usage';
import { StoppedError } from './abort';

export type ProviderKind = 'anthropic' | 'zoask' | 'opencode' | 'nim' | 'gemini' | 'custom';
export type ModelTier = 'fast' | 'balanced' | 'heavy';

export interface AiProviderRow {
  id: string;
  account_id: string;
  name: string;
  kind: ProviderKind;
  base_url: string | null;
  api_key_encrypted: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AiModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  label: string | null;
  tier: ModelTier;
  good: string[];
  reliable: boolean;
  enabled: boolean;
  /** The model's real output-token ceiling (migration 038). NULL = unknown,
   *  in which case KIND_MAX_OUTPUT_TOKENS supplies a per-kind fallback. */
  max_output_tokens: number | null;
  /** Total input+output capacity (migration 058). NULL = unknown, which means
   *  the eligibility filter cannot rule the model out — never that it fits. */
  context_window: number | null;
  /** USD per million tokens (migration 058). 0 is a real value: the free
   *  OpenRouter roster genuinely costs nothing. NULL means unknown, and unknown
   *  is NOT free — a model with no price must never win a cost tiebreak. */
  cost_per_mtok_in: number | null;
  cost_per_mtok_out: number | null;
  created_at: string;
}

export interface AiRoutingRow {
  account_id: string;
  active_model_id: string | null;
  fallback_chain: string[];
  updated_at: string;
}

export interface ResolvedModel {
  provider: AiProviderRow;
  model: AiModelRow;
}

/** True only when the registry has real work to do for this account — lets
 * router.ts skip a DB round-trip entirely for accounts with zero config. */
export async function registryConfigured(accountId: string | undefined | null): Promise<boolean> {
  if (!accountId || !dbReady()) return false;
  const { data } = await supabase
    .from('ai_routing')
    .select('account_id')
    .eq('account_id', accountId)
    .maybeSingle();
  return Boolean(data);
}

// ---------------------------------------------------------------------------
// CRUD — providers
// ---------------------------------------------------------------------------

export async function listProviders(accountId: string): Promise<(Omit<AiProviderRow, 'api_key_encrypted'> & { has_key: boolean; key_preview: string | null })[]> {
  const { data, error } = await supabase
    .from('ai_providers')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((row: AiProviderRow) => {
    const { api_key_encrypted, ...rest } = row;
    let preview: string | null = null;
    if (api_key_encrypted) {
      try { preview = maskSecret(decryptSecret(api_key_encrypted)); } catch { preview = '••••••••'; }
    }
    return { ...rest, has_key: Boolean(api_key_encrypted), key_preview: preview };
  });
}

export async function createProvider(accountId: string, input: {
  name: string; kind: ProviderKind; base_url?: string | null; api_key?: string | null; enabled?: boolean;
}): Promise<AiProviderRow> {
  const row: Record<string, any> = {
    account_id: accountId,
    name: input.name,
    kind: input.kind,
    base_url: input.base_url ?? null,
    enabled: input.enabled ?? true,
  };
  if (input.api_key) {
    if (!vaultConfigured()) {
      const err: any = new Error('AI_VAULT_KEY is not set on this deployment; cannot store a provider key');
      err.code = 'vault_not_configured';
      throw err;
    }
    row.api_key_encrypted = encryptSecret(input.api_key);
  }
  const { data, error } = await supabase.from('ai_providers').insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function updateProvider(accountId: string, providerId: string, patch: {
  name?: string; base_url?: string | null; api_key?: string | null; enabled?: boolean;
}): Promise<AiProviderRow> {
  const row: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.base_url !== undefined) row.base_url = patch.base_url;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.api_key) {
    row.api_key_encrypted = encryptSecret(patch.api_key);
  }
  const { data, error } = await supabase
    .from('ai_providers')
    .update(row)
    .eq('id', providerId)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('provider not found');
  return data;
}

export async function deleteProvider(accountId: string, providerId: string): Promise<{ id: string; deleted: true }> {
  const { data, error } = await supabase
    .from('ai_providers')
    .delete()
    .eq('id', providerId)
    .eq('account_id', accountId)
    .select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('provider not found');
  return { id: providerId, deleted: true };
}

/** Verify a provider belongs to accountId — same pattern as assertBrandOwned. */
async function assertProviderOwned(providerId: string, accountId: string): Promise<AiProviderRow> {
  const { data, error } = await supabase
    .from('ai_providers')
    .select('*')
    .eq('id', providerId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('unknown provider');
  return data;
}

// ---------------------------------------------------------------------------
// CRUD — models
// ---------------------------------------------------------------------------

export async function listModels(accountId: string, providerId?: string): Promise<AiModelRow[]> {
  // Models are scoped indirectly through their provider's account_id; join via
  // provider ids owned by this account so a client can never list another
  // tenant's models even if it guesses a provider_id.
  const { data: providers, error: provErr } = await supabase
    .from('ai_providers')
    .select('id')
    .eq('account_id', accountId);
  if (provErr) throw provErr;
  const ownedIds = (providers || []).map((p: { id: string }) => p.id);
  if (!ownedIds.length) return [];
  let q = supabase.from('ai_models').select('*').in('provider_id', ownedIds);
  if (providerId) q = q.eq('provider_id', providerId);
  const { data, error } = await q.order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export interface SelectableModel {
  /** ai_models row id — what a caller sends back as RunAgentInput.modelId /
   *  resolveChain's `modelId` option, NOT ai_models.model_id. */
  id: string;
  model_id: string;
  label: string | null;
  tier: ModelTier;
  provider: string;
}

/** Enabled models for the account's composer model picker: enabled ai_models
 * rows joined to their enabled ai_providers row, account-scoped through the
 * provider (same scoping as listModels above — a client can never see or
 * select another tenant's models). Disabled models/providers are excluded so
 * the dropdown never offers something the account turned off. */
export async function listSelectableModels(accountId: string): Promise<SelectableModel[]> {
  const { data: providers, error: provErr } = await supabase
    .from('ai_providers')
    .select('id, name')
    .eq('account_id', accountId)
    .eq('enabled', true);
  if (provErr) throw provErr;
  const providerById = new Map((providers || []).map((p: { id: string; name: string }) => [p.id, p.name]));
  const ownedIds = Array.from(providerById.keys());
  if (!ownedIds.length) return [];
  const { data: models, error } = await supabase
    .from('ai_models')
    .select('id, provider_id, model_id, label, tier')
    .in('provider_id', ownedIds)
    .eq('enabled', true)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (models || []).map((m: any) => ({
    id: m.id,
    model_id: m.model_id,
    label: m.label,
    tier: m.tier,
    provider: providerById.get(m.provider_id) || 'Unknown',
  }));
}

/** Validate a client-supplied model id against THIS account's own enabled
 * ai_models rows before it is allowed anywhere near the router. Returns the
 * id back only when it belongs to this account and is currently enabled
 * (through an enabled provider); otherwise returns undefined so the caller
 * ignores it — NEVER trust a client-supplied model id straight through. */
export async function assertSelectableModel(accountId: string, modelId: string | undefined): Promise<string | undefined> {
  if (!modelId) return undefined;
  const selectable = await listSelectableModels(accountId);
  return selectable.some((m) => m.id === modelId) ? modelId : undefined;
}

export async function addModel(accountId: string, providerId: string, input: {
  max_output_tokens?: number | null;
  model_id: string; label?: string | null; tier?: ModelTier; good?: string[]; reliable?: boolean; enabled?: boolean;
}): Promise<AiModelRow> {
  await assertProviderOwned(providerId, accountId);
  const row = {
    provider_id: providerId,
    model_id: input.model_id,
    label: input.label ?? null,
    tier: input.tier ?? 'balanced',
    good: input.good ?? [],
    max_output_tokens: input.max_output_tokens ?? null,
    reliable: input.reliable ?? true,
    enabled: input.enabled ?? true,
  };
  const { data, error } = await supabase.from('ai_models').insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function updateModel(accountId: string, modelId: string, patch: {
  max_output_tokens?: number | null;
  label?: string | null; tier?: ModelTier; good?: string[]; reliable?: boolean; enabled?: boolean;
}): Promise<AiModelRow> {
  // Ownership check: the model's provider must belong to this account.
  const { data: existing, error: exErr } = await supabase.from('ai_models').select('*, ai_providers!inner(account_id)').eq('id', modelId).maybeSingle();
  if (exErr) throw exErr;
  if (!existing || (existing as any).ai_providers?.account_id !== accountId) throw new Error('unknown model');
  const row: Record<string, any> = {};
  if (patch.label !== undefined) row.label = patch.label;
  if (patch.tier !== undefined) row.tier = patch.tier;
  if (patch.good !== undefined) row.good = patch.good;
  if (patch.max_output_tokens !== undefined) row.max_output_tokens = patch.max_output_tokens;
  if (patch.reliable !== undefined) row.reliable = patch.reliable;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  const { data, error } = await supabase.from('ai_models').update(row).eq('id', modelId).select().single();
  if (error) throw error;
  return data;
}

export async function removeModel(accountId: string, modelId: string): Promise<{ id: string; deleted: true }> {
  const { data: existing, error: exErr } = await supabase.from('ai_models').select('*, ai_providers!inner(account_id)').eq('id', modelId).maybeSingle();
  if (exErr) throw exErr;
  if (!existing || (existing as any).ai_providers?.account_id !== accountId) throw new Error('unknown model');
  const { error } = await supabase.from('ai_models').delete().eq('id', modelId);
  if (error) throw error;
  return { id: modelId, deleted: true };
}

// ---------------------------------------------------------------------------
// Routing — active model + fallback chain
// ---------------------------------------------------------------------------

export async function getRouting(accountId: string): Promise<AiRoutingRow | null> {
  const { data, error } = await supabase.from('ai_routing').select('*').eq('account_id', accountId).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function assertModelsOwned(accountId: string, modelIds: string[]): Promise<void> {
  if (!modelIds.length) return;
  const owned = await listModels(accountId);
  const ownedIds = new Set(owned.map((m) => m.id));
  for (const id of modelIds) {
    if (!ownedIds.has(id)) throw new Error(`model ${id} does not belong to this account`);
  }
}

export async function setRouting(accountId: string, input: { active_model_id?: string | null; fallback_chain?: string[] }): Promise<AiRoutingRow> {
  const ids = [
    ...(input.active_model_id ? [input.active_model_id] : []),
    ...(input.fallback_chain || []),
  ];
  await assertModelsOwned(accountId, ids);
  const row = {
    account_id: accountId,
    active_model_id: input.active_model_id ?? null,
    fallback_chain: input.fallback_chain ?? [],
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('ai_routing').upsert(row, { onConflict: 'account_id' }).select().single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Chain resolution + normalized call
// ---------------------------------------------------------------------------

/**
 * Resolve an account's configured chain: [active, ...fallback], each entry
 * joined with its provider row, skipping disabled providers/models and any
 * id that no longer resolves (deleted after being set as active/fallback).
 * Returns [] when nothing is configured — callers must treat that as "use the
 * hardcoded ladder instead", never as an error.
 */
export async function resolveChain(accountId: string, _opts: { modelId?: string } = {}): Promise<ResolvedModel[]> {
  if (!dbReady() || !accountId) return [];
  const routing = await getRouting(accountId);
  if (!routing) return [];

  const orderedIds = [
    ...(_opts.modelId ? [_opts.modelId] : []),
    ...(routing.active_model_id ? [routing.active_model_id] : []),
    ...(Array.isArray(routing.fallback_chain) ? routing.fallback_chain : []),
  ];
  if (!orderedIds.length) return [];

  const { data: models, error } = await supabase.from('ai_models').select('*').in('id', Array.from(new Set(orderedIds)));
  if (error) throw error;
  const modelById = new Map((models || []).map((m: AiModelRow) => [m.id, m]));

  const providerIds = Array.from(new Set((models || []).map((m: AiModelRow) => m.provider_id)));
  if (!providerIds.length) return [];
  const { data: providers, error: provErr } = await supabase.from('ai_providers').select('*').in('id', providerIds);
  if (provErr) throw provErr;
  const providerById = new Map((providers || []).map((p: AiProviderRow) => [p.id, p]));

  const chain: ResolvedModel[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const model = modelById.get(id);
    if (!model || !model.enabled) continue;
    const provider = providerById.get(model.provider_id);
    if (!provider || !provider.enabled || provider.account_id !== accountId) continue;
    chain.push({ provider, model });
  }
  return chain;
}

// ---------------------------------------------------------------------------
// PAID vs FREE — which task shape deserves which
// ---------------------------------------------------------------------------
// `cost_per_mtok_out > 0` is the paid signal (migration 076-era cleanup made
// this reliable: every OpenRouter `:free` model now has cost 0, not NULL — see
// BACKLOG). The `:free` substring is deliberately NOT used here; it is an
// OpenRouter naming convention, not a cost fact, and a non-OpenRouter provider
// has no such substring to match on at all.
//
// `ai_models.good` (migration 023) already tags each model with the task
// shapes it suits. We reuse that same vocabulary to decide cheap vs
// substantive rather than inventing a second one:
//   - CHEAP:       'classify', 'extract'   — structured, low-judgment shapes.
//     A free model's weaker instruction-following rarely shows on these, so
//     spending on them buys nothing; free models are preferred.
//   - SUBSTANTIVE: 'reason', 'long', 'draft', 'code' — judgment-heavy shapes
//     where a paid model's quality is worth its cost; paid models are
//     preferred.
// A task tag outside both sets (or no task at all) gets no cost-based
// reordering — only the `good`-tag/tier ranking below applies, exactly as
// before this rule existed.
const CHEAP_TASKS = new Set(['classify', 'extract']);
const SUBSTANTIVE_TASKS = new Set(['reason', 'long', 'draft', 'code']);

export function isPaidModel(model: AiModelRow): boolean {
  return typeof model.cost_per_mtok_out === 'number' && model.cost_per_mtok_out > 0;
}

/** Stable paid/free split for one task-tag group: preserves the incoming
 *  (already tier/good ranked) order within each half. Exported so this rule
 *  can be tested directly against plain ResolvedModel arrays, without a DB. */
export function orderByCost(models: ResolvedModel[], task: string): ResolvedModel[] {
  if (SUBSTANTIVE_TASKS.has(task)) {
    return [...models.filter((r) => isPaidModel(r.model)), ...models.filter((r) => !isPaidModel(r.model))];
  }
  if (CHEAP_TASKS.has(task)) {
    return [...models.filter((r) => !isPaidModel(r.model)), ...models.filter((r) => isPaidModel(r.model))];
  }
  return models;
}

/**
 * Reorders an account's existing model chain for a specific task without
 * removing any models.
 *
 * `ai_models.good` (migration 023) and `TaskKind` in `lib/ai/models.ts`
 * already describe which model suits which job, but `resolveChain` never read
 * them. This wires that up.
 *
 * Reordering only: models whose `good` list contains `task` move to the
 * front (optionally with a preferred tier first), and everything else keeps
 * the order returned by `resolveChain`. An account with no task tags
 * therefore behaves exactly as before. Within each of those groups, paid vs
 * free models are then reordered per `orderByCost` above. This function
 * never throws.
 */
export async function resolveChainForTask(
  accountId: string,
  task: string,
  opts?: { preferTier?: 'fast' | 'balanced' | 'heavy' },
): Promise<ResolvedModel[]> {
  let chain: ResolvedModel[];
  try {
    chain = await resolveChain(accountId);
  } catch {
    return [];
  }

  if (!chain.length) return [];

  const preferTier = opts?.preferTier;
  const tierMatches: ResolvedModel[] = [];
  const goodMatches: ResolvedModel[] = [];
  const rest: ResolvedModel[] = [];

  for (const resolved of chain) {
    const good = Array.isArray(resolved.model.good) ? resolved.model.good : [];
    const isGoodForTask = good.includes(task);

    if (isGoodForTask && (preferTier === undefined || resolved.model.tier === preferTier)) {
      tierMatches.push(resolved);
    } else if (isGoodForTask) {
      goodMatches.push(resolved);
    } else {
      rest.push(resolved);
    }
  }

  const deduped: ResolvedModel[] = [];
  const seen = new Set<string>();

  for (const resolved of [
    ...orderByCost(tierMatches, task),
    ...orderByCost(goodMatches, task),
    ...orderByCost(rest, task),
  ]) {
    if (seen.has(resolved.model.id)) continue;
    seen.add(resolved.model.id);
    deduped.push(resolved);
  }

  return deduped;
}

/** Per-provider-kind fallback ceilings, used when ai_models.max_output_tokens
 *  is NULL (unknown) - e.g. the hardcoded ladder, which has no DB rows. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

export const KIND_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'anthropic': 8192,
  'openai-compatible': 8192,
  'gemini': 8192,
  'nim': 4096,
  'opencode': 8192,
  'zoask': 8192,
  'custom': 4096,
};

/**
 * Resolve the maximum output tokens for a given resolved model.
 *
 * A caller passing no explicit budget gets the model's own capability,
 * optionally bounded by a ceiling for cost/latency, rather than a fixed
 * constant; an explicit request is clamped DOWN to what the model can
 * actually emit so a request never exceeds the model's real limit.
 */
export function resolveMaxOutputTokens(
  resolved: { provider: { kind: string }; model: { max_output_tokens?: number | null } },
  requested?: number,
  ceiling?: number,
): number {
  const cap = resolved.model.max_output_tokens ?? KIND_MAX_OUTPUT_TOKENS[resolved.provider.kind] ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const result = requested && requested > 0 ? Math.min(requested, cap) : Math.min(cap, ceiling ?? cap);
  return Math.max(1, Math.floor(result));
}

export interface CallModelOpts {
  system?: string;
  prompt?: string;              // text mode
  messages?: { role: 'user' | 'assistant'; content: string }[]; // chat mode
  temperature?: number;
  /** Explicit budget. Clamped DOWN to the model's real ceiling. Omit to let the
   *  selected model's own capability decide (migration 038). */
  maxOutputTokens?: number;
  /** Upper bound applied when maxOutputTokens is omitted — lets a caller say
   *  "use the model's capability, but not more than this" for cost/latency. */
  maxOutputCeiling?: number;
  /** External abort for an in-flight cooperative stop (lib/agent/
   *  stop-watch.ts). Optional/additive: omitted, behaviour is unchanged.
   *  Forwarded to every branch below (zoask, opencode, nim, gemini,
   *  anthropic, custom). */
  signal?: AbortSignal;
}

/**
 * Normalize a single call across every provider kind behind one interface.
 * Text mode is used when `prompt` is set; chat mode when `messages` is set.
 */
export async function callModel(resolved: ResolvedModel, opts: CallModelOpts): Promise<string> {
  const { provider, model } = resolved;
  const isChat = Array.isArray(opts.messages);
  // Budget follows the MODEL, not a constant (migration 038): an omitted
  // request resolves to the model's own ceiling; an explicit one is clamped
  // down so we never ask for more than the model can emit.
  opts = { ...opts, maxOutputTokens: resolveMaxOutputTokens(resolved, opts.maxOutputTokens, opts.maxOutputCeiling) };

  switch (provider.kind) {
    case 'zoask': {
      if (!zoAskConfigured()) throw Object.assign(new Error('Zo Ask is not connected'), { code: 'not_configured' });
      return isChat
        ? zoAskChat({ system: opts.system, messages: opts.messages!, maxOutputTokens: opts.maxOutputTokens, model: model.model_id, signal: opts.signal })
        : zoAskText({ system: opts.system, prompt: opts.prompt || '', maxOutputTokens: opts.maxOutputTokens, signal: opts.signal });
    }
    case 'opencode': {
      if (!opencode.opencodeConfigured()) throw Object.assign(new Error('OpenCode is not connected'), { code: 'not_configured' });
      return isChat
        ? opencode.generateChat({ system: opts.system, messages: opts.messages as any, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, model: model.model_id, signal: opts.signal })
        : opencode.generateText({ system: opts.system, prompt: opts.prompt || '', temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, model: model.model_id, signal: opts.signal });
    }
    case 'nim': {
      if (!nimConfigured()) throw Object.assign(new Error('NIM is not connected'), { code: 'not_configured' });
      return isChat
        ? nimChat({ system: opts.system, messages: opts.messages!, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, signal: opts.signal })
        : nimText({ system: opts.system, prompt: opts.prompt || '', temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, signal: opts.signal });
    }
    case 'gemini': {
      if (!gemini.geminiConfigured()) throw Object.assign(new Error('Gemini is not connected'), { code: 'not_configured' });
      return isChat
        ? gemini.generateChat({ system: opts.system, messages: opts.messages as any, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, signal: opts.signal })
        : gemini.generateText({ system: opts.system, prompt: opts.prompt || '', temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, signal: opts.signal });
    }
    case 'anthropic':
      return callAnthropic(provider, model, opts, isChat);
    case 'custom':
      // No generic transport is safe to guess for an arbitrary custom kind;
      // treat it the same as openai-compatible (the common denominator for
      // "custom" self-hosted/gateway endpoints) rather than throwing outright.
      return callOpenAiCompatible(provider, model, opts, isChat);
    default:
      throw new Error(`Unsupported provider kind: ${provider.kind}`);
  }
}

// Env var that already holds each provider kind's key. The hardcoded tier
// clients (lib/ai/nim.ts, openrouter.ts, …) read these today, so a registry row
// can reuse the same credential instead of requiring it to be re-entered and
// stored twice.
const KIND_ENV_KEY: Record<string, string | undefined> = {
  nim: process.env.NIM_API_KEY,
  opencode: process.env.OPENCODE_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
  huggingface: process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN,
  zoask: process.env.ZOASK_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
};

function decryptProviderKey(provider: AiProviderRow): string {
  // A stored key always wins — that is the BYOK case, and an operator who
  // entered a key means to use it.
  if (provider.api_key_encrypted) return decryptSecret(provider.api_key_encrypted);

  // Otherwise fall back to the env credential for this kind. Without this the
  // registry is unusable unless every key is re-entered through the UI and
  // encrypted — which is why ai_providers has sat empty and the whole
  // registry path (per-model ceilings, tier routing, fallback_chain) has been
  // dead code. A row with no key now means "use the platform credential",
  // which is the common case.
  const envKey = KIND_ENV_KEY[provider.kind];
  if (envKey) return envKey;

  // OpenRouter and HuggingFace are both OpenAI-compatible, so they are stored as
  // kind 'custom' — which means `kind` alone cannot say which credential they
  // need. Resolve those by base_url instead. Matching on host, not the full
  // string, so a trailing slash or an /v1 suffix does not break it.
  const host = (provider.base_url || '').toLowerCase();
  if (host.includes('openrouter.ai')) {
    const k = process.env.OPENROUTER_API_KEY;
    if (k) return k;
  }
  if (host.includes('huggingface.co')) {
    const k = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
    if (k) return k;
  }

  const err: any = new Error(`Provider "${provider.name}" has no API key configured`);
  err.code = 'not_configured';
  throw err;
}

async function callOpenAiCompatible(provider: AiProviderRow, model: AiModelRow, opts: CallModelOpts, isChat: boolean): Promise<string> {
  const key = decryptProviderKey(provider);
  const base = (provider.base_url || 'https://api.openai.com/v1').replace(/\/$/, '');
  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  if (isChat) {
    for (const m of opts.messages!) if (m.content?.trim()) messages.push({ role: m.role, content: m.content });
  } else {
    messages.push({ role: 'user', content: opts.prompt || '' });
  }
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.model_id,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      }),
      // No existing timeout/AbortController here to combine with (unlike
      // zoask/opencode/nim) — passed straight through as the fetch's own
      // signal, the least invasive addition consistent with those clients.
      signal: opts.signal,
    });
  } catch (e: any) {
    // The CALLER's signal firing is a stop, not an ordinary transport
    // failure — see zoask.ts's matching comment.
    if (opts.signal?.aborted) throw new StoppedError(`${provider.name} call aborted: stop requested`);
    throw e;
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`${provider.name} failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = detail;
    throw err;
  }
  const json = await res.json();
  // This file had ZERO usage reporting, which is why the registry path never
  // recorded tokens: an account model whose provider kind is 'custom' (the
  // HuggingFace router and OpenRouter entries both are) is served here, NOT by
  // lib/ai/huggingface.ts — that client reports usage, this branch did not.
  // "Llama 3.3 70B" logged 15 successful calls and 0 token counts because of it.
  reportOpenAIUsage(json);
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

async function callAnthropic(provider: AiProviderRow, model: AiModelRow, opts: CallModelOpts, isChat: boolean): Promise<string> {
  const key = decryptProviderKey(provider);
  const base = (provider.base_url || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  if (isChat) {
    for (const m of opts.messages!) if (m.content?.trim()) messages.push({ role: m.role, content: m.content });
  } else {
    messages.push({ role: 'user', content: opts.prompt || '' });
  }
  const body: Record<string, any> = {
    model: model.model_id,
    max_tokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    messages,
  };
  if (opts.system) body.system = opts.system;
  if (opts.temperature != null) body.temperature = opts.temperature;

  let res: Response;
  try {
    res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      // Same as callOpenAiCompatible above: no existing internal timeout to
      // combine with, so the caller's signal is passed straight through —
      // the least invasive addition consistent with zoask/opencode/nim's
      // AbortSignal.any pattern.
      signal: opts.signal,
    });
  } catch (e: any) {
    if (opts.signal?.aborted) throw new StoppedError(`${provider.name} call aborted: stop requested`);
    throw e;
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`${provider.name} failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = detail;
    throw err;
  }
  const json = await res.json();
  // Anthropic spells them input_tokens/output_tokens, which reportOpenAIUsage
  // already reads as its second spelling — so the same helper covers both
  // dialects and there is no second parser to keep in sync.
  reportOpenAIUsage(json);
  const parts = Array.isArray(json?.content) ? json.content : [];
  return parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
}

// ---------------------------------------------------------------------------
// Streaming (Packet 8.1c) — pure addition. callModel() above is untouched.
// ---------------------------------------------------------------------------

/**
 * Streaming twin of `callModel`. Forwards each token delta to `onDelta` and
 * resolves with the COMPLETE text, so a caller can treat it exactly like
 * `callModel` and ignore `onDelta` entirely.
 *
 * Kinds that cannot stream (zoask, gemini) fall back to a buffered `callModel`
 * and emit the whole answer as ONE delta — the caller must not care which
 * happened.
 */
export async function callModelStream(
  resolved: ResolvedModel,
  opts: CallModelOpts,
  onDelta: (chunk: string) => void,
): Promise<string> {
  const { provider, model } = resolved;
  const isChat = Array.isArray(opts.messages);
  // Same budget resolution as callModel (migration 038).
  opts = { ...opts, maxOutputTokens: resolveMaxOutputTokens(resolved, opts.maxOutputTokens, opts.maxOutputCeiling) };

  switch (provider.kind) {
    case 'opencode': {
      if (!opencode.opencodeConfigured()) throw Object.assign(new Error('OpenCode is not connected'), { code: 'not_configured' });
      if (!isChat) break; // text mode has no streaming variant; buffer below
      return opencode.streamChat(
        { system: opts.system, messages: opts.messages as any, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, model: model.model_id, signal: opts.signal },
        onDelta,
      );
    }
    case 'nim': {
      if (!nimConfigured()) throw Object.assign(new Error('NIM is not connected'), { code: 'not_configured' });
      if (!isChat) break;
      return nimStreamChat(
        { system: opts.system, messages: opts.messages!, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens },
        onDelta,
      );
    }
    // 'openai-compatible' was main's name for what this branch calls 'custom';
    // both reach the same handler. Kept as 'custom' only, matching ProviderKind.
    case 'custom':
      return streamOpenAiCompatible(provider, model, opts, isChat, onDelta);
    case 'anthropic':
      return streamAnthropic(provider, model, opts, isChat, onDelta);
    default:
      break; // zoask, gemini, and anything unknown: buffered path below
  }

  // Non-streaming tier: produce the same result, delivered as one delta.
  const text = await callModel(resolved, opts);
  if (text) onDelta(text);
  return text;
}

async function streamOpenAiCompatible(
  provider: AiProviderRow,
  model: AiModelRow,
  opts: CallModelOpts,
  isChat: boolean,
  onDelta: (chunk: string) => void,
): Promise<string> {
  const key = decryptProviderKey(provider);
  const base = (provider.base_url || 'https://api.openai.com/v1').replace(/\/$/, '');
  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  if (isChat) {
    for (const m of opts.messages!) if (m.content?.trim()) messages.push({ role: m.role, content: m.content });
  } else {
    messages.push({ role: 'user', content: opts.prompt || '' });
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.model_id,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      stream: true,
      // Ask the gateway to append a final chunk carrying the token counts.
      // Without it an OpenAI-dialect stream reports no usage at all, which is
      // why 363 of 364 ai_usage rows had NULL tokens. OpenAI-compatible only —
      // deliberately NOT sent on the Anthropic branch, where it is not a valid
      // parameter and usage arrives unprompted on message_start/message_delta.
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`${provider.name} failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = detail;
    throw err;
  }
  if (!res.body) {
    const err: any = new Error(`${provider.name} returned no response stream`);
    err.code = 'upstream';
    throw err;
  }
  let text = '';
  await opencode.readSseDeltas(res.body, (evt) => {
    const chunk = evt?.choices?.[0]?.delta?.content;
    if (typeof chunk === 'string' && chunk) { text += chunk; onDelta(chunk); }
  });
  return text.trim();
}

async function streamAnthropic(
  provider: AiProviderRow,
  model: AiModelRow,
  opts: CallModelOpts,
  isChat: boolean,
  onDelta: (chunk: string) => void,
): Promise<string> {
  const key = decryptProviderKey(provider);
  const base = (provider.base_url || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  if (isChat) {
    for (const m of opts.messages!) if (m.content?.trim()) messages.push({ role: m.role, content: m.content });
  } else {
    messages.push({ role: 'user', content: opts.prompt || '' });
  }
  const body: Record<string, any> = {
    model: model.model_id,
    max_tokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    messages,
    stream: true,
  };
  if (opts.system) body.system = opts.system;
  if (opts.temperature != null) body.temperature = opts.temperature;

  const res = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`${provider.name} failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = detail;
    throw err;
  }
  if (!res.body) {
    const err: any = new Error(`${provider.name} returned no response stream`);
    err.code = 'upstream';
    throw err;
  }
  let text = '';
  await opencode.readSseDeltas(res.body, (evt) => {
    if (evt?.type !== 'content_block_delta') return;
    const chunk = evt?.delta?.text;
    if (typeof chunk === 'string' && chunk) { text += chunk; onDelta(chunk); }
  });
  return text.trim();
}

/** Lightweight connectivity probe used by the "test connection" UI action —
 * a short, cheap prompt with a tight token budget, never billed as real usage. */
export async function testConnection(resolved: ResolvedModel): Promise<{ ok: boolean; detail?: string }> {
  try {
    const text = await callModel(resolved, { prompt: 'Reply with exactly: ok', maxOutputTokens: 8, temperature: 0 });
    return { ok: text.length > 0 };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e).slice(0, 300) };
  }
}

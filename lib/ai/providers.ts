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

export type ProviderKind = 'openai-compatible' | 'anthropic' | 'zoask' | 'opencode' | 'nim' | 'gemini' | 'custom';
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
 * therefore behaves exactly as before. This function never throws.
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

  for (const resolved of [...tierMatches, ...goodMatches, ...rest]) {
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
        ? zoAskChat({ system: opts.system, messages: opts.messages!, maxOutputTokens: opts.maxOutputTokens, model: model.model_id })
        : zoAskText({ system: opts.system, prompt: opts.prompt || '', maxOutputTokens: opts.maxOutputTokens });
    }
    case 'opencode': {
      if (!opencode.opencodeConfigured()) throw Object.assign(new Error('OpenCode is not connected'), { code: 'not_configured' });
      return isChat
        ? opencode.generateChat({ system: opts.system, messages: opts.messages as any, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, model: model.model_id })
        : opencode.generateText({ system: opts.system, prompt: opts.prompt || '', temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, model: model.model_id });
    }
    case 'nim': {
      if (!nimConfigured()) throw Object.assign(new Error('NIM is not connected'), { code: 'not_configured' });
      return isChat
        ? nimChat({ system: opts.system, messages: opts.messages!, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens })
        : nimText({ system: opts.system, prompt: opts.prompt || '', temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens });
    }
    case 'gemini': {
      if (!gemini.geminiConfigured()) throw Object.assign(new Error('Gemini is not connected'), { code: 'not_configured' });
      return isChat
        ? gemini.generateChat({ system: opts.system, messages: opts.messages as any, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens })
        : gemini.generateText({ system: opts.system, prompt: opts.prompt || '', temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens });
    }
    case 'openai-compatible':
      return callOpenAiCompatible(provider, model, opts, isChat);
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

function decryptProviderKey(provider: AiProviderRow): string {
  if (!provider.api_key_encrypted) {
    const err: any = new Error(`Provider "${provider.name}" has no API key configured`);
    err.code = 'not_configured';
    throw err;
  }
  return decryptSecret(provider.api_key_encrypted);
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
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.model_id,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err: any = new Error(`${provider.name} failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = detail;
    throw err;
  }
  const json = await res.json();
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
  const json = await res.json();
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
        { system: opts.system, messages: opts.messages as any, temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, model: model.model_id },
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
    case 'openai-compatible':
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

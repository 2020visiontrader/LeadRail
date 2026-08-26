// Check every configured model against its provider's live catalogue.
//
// WHY THIS EXISTS RATHER THAN A CORRECTED SLUG. A model id that 404s today was
// almost certainly valid when it was added: OpenRouter's free roster in
// particular is churned constantly — models are added, renamed, repriced and
// pulled, and `:free` variants come and go faster than anything else. Hardcoding
// a replacement fixes one slug until that one rots too, and nothing tells you
// when it does. The usage panel will happily show 0% for a month.
//
// So this asks the provider what it actually offers and compares. It is the
// difference between "this model is broken" and "this model no longer exists,
// here are the closest ones that do".
//
// OpenRouter's catalogue needs no API key, which is what makes this cheap
// enough to run from a diagnostics page whenever someone wonders why a tier is
// dead.

import { supabase, dbReady } from '@/lib/db';
import { MODEL_CHAIN as OPENROUTER_CHAIN } from '@/lib/ai/openrouter';

const CATALOGUE_TIMEOUT_MS = 10_000;

export interface ModelCheck {
  label: string;
  modelId: string;
  provider: string;
  status: 'ok' | 'missing' | 'unchecked';
  /** Why it could not be checked, or what is wrong with it. */
  note?: string;
  /** Live ids that look like what was meant. Suggestions only — a slug is
   *  pasted by a person who knows which model they want, and guessing on their
   *  behalf is how you get a second wrong id. */
  didYouMean?: string[];
}

/** What the catalogue tells us about one model. Every field is optional: this
 *  is another service's response shape, and a field that moves or disappears
 *  must degrade to "unknown" rather than to a wrong number written into our
 *  database. */
export interface CatalogueEntry {
  id: string;
  contextWindow?: number;
  maxOutput?: number;
  /** USD per MILLION tokens. OpenRouter quotes per-token strings; converted
   *  here so the unit matches the column and nobody has to remember which is
   *  which at the call site. */
  costInPerMTok?: number;
  costOutPerMTok?: number;
}

/** OpenRouter publishes its full model list unauthenticated. */
async function openRouterCatalogue(): Promise<Map<string, CatalogueEntry> | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const out = new Map<string, CatalogueEntry>();
    for (const m of json?.data || []) {
      const id = String(m?.id || '');
      if (!id) continue;
      out.set(id, {
        id,
        contextWindow: posInt(m?.context_length),
        maxOutput: posInt(m?.top_provider?.max_completion_tokens),
        costInPerMTok: perMillion(m?.pricing?.prompt),
        costOutPerMTok: perMillion(m?.pricing?.completion),
      });
    }
    return out.size ? out : null;
  } catch {
    return null;
  }
}

function posInt(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** OpenRouter quotes price per token as a decimal string ("0.0000004", and
 *  "0" for the free roster). Zero is a real price and must survive; anything
 *  unparseable becomes undefined, because a missing price is not a free one. */
function perMillion(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  return n * 1_000_000;
}

/** Ids that share the family but not the exact name — a renamed or repriced
 *  variant is the commonest cause, so the base name before `:` is the useful
 *  thing to match on. */
function suggestionsFor(wanted: string, live: Map<string, CatalogueEntry>): string[] {
  const base = wanted.split(':')[0].toLowerCase();
  const stem = base.split('/').pop() || base;
  // Progressively looser: exact family, then any id sharing a distinctive
  // chunk of the name.
  const ids = [...live.keys()];
  const family = ids.filter((id) => id.toLowerCase().startsWith(base));
  if (family.length) return family.slice(0, 5);
  const parts = stem.split(/[-_.]/).filter((p) => p.length > 3);
  if (!parts.length) return [];
  return ids
    .filter((id) => parts.filter((p) => id.toLowerCase().includes(p)).length >= 2)
    .slice(0, 5);
}

/**
 * Check the account's configured models.
 *
 * Only OpenRouter is verifiable without credentials, so everything else is
 * reported as `unchecked` rather than assumed fine — claiming a model is
 * healthy because we could not look at it is exactly the kind of false green
 * that lets a dead tier sit for a month.
 */
export async function validateModels(accountId?: string): Promise<{
  checks: ModelCheck[];
  catalogueReachable: boolean;
}> {
  const live = await openRouterCatalogue();

  const judge = (label: string, modelId: string, provider: string): ModelCheck => {
    const base: ModelCheck = { label, modelId, provider, status: 'unchecked' };
    if (!/openrouter/i.test(provider)) {
      return { ...base, note: 'This provider publishes no open catalogue, so the id cannot be verified from here.' };
    }
    if (!live) {
      return { ...base, note: "OpenRouter's catalogue could not be reached, so nothing was checked." };
    }
    if (live.has(modelId)) return { ...base, status: 'ok' };
    return {
      ...base,
      status: 'missing',
      note: 'OpenRouter has no model with this id — it has been renamed, repriced or withdrawn. This is the 404.',
      didYouMean: suggestionsFor(modelId, live),
    };
  };

  // THE CHAIN FIRST, because the chain is what actually gets called. The
  // `ai_models` rows are the Admin panel's display registry; a dead id there is
  // cosmetic, while a dead id in MODEL_CHAIN is the tier silently costing a
  // round trip on every walk past it. Checking only the table would have
  // reported a clean bill of health while the live chain 404'd.
  const checks: ModelCheck[] = OPENROUTER_CHAIN.map((id, i) =>
    judge(`OpenRouter chain #${i + 1}`, id, 'OpenRouter'),
  );

  if (dbReady()) {
    let q = supabase
      .from('ai_models')
      .select('label, model_id, enabled, ai_providers!inner(name, kind, account_id)')
      .eq('enabled', true);
    if (accountId) q = q.eq('ai_providers.account_id', accountId);
    const { data } = await q;
    for (const r of (data || []) as any[]) {
      checks.push(judge(r.label || r.model_id, String(r.model_id || ''), r.ai_providers?.name || 'unknown'));
    }
  }

  return { checks, catalogueReachable: Boolean(live) };
}

// ---------------------------------------------------------------------------
// CAPABILITY SYNC
// ---------------------------------------------------------------------------
// Migration 058 added context_window and cost columns; the eligibility filter
// reads them and treats NULL as "cannot rule this model out". So until they are
// filled the filter does nothing, which is the correct failure but not a useful
// state to sit in.
//
// They are filled from the provider's own catalogue rather than typed in. Two
// reasons, and the second is the important one. A context window is a fact the
// provider publishes, so copying it by hand is error-prone work that a request
// does better. And these numbers CHANGE — a model gets repriced, a provider
// raises a window — and a hand-entered figure has no way to notice, which is
// how a routing decision ends up being made on a value that was true in March.
//
// Only what the catalogue actually stated is written. A model the catalogue
// does not mention, or a field it does not carry, is left exactly as it was:
// overwriting a known value with NULL because one response was missing a key
// would quietly disable the filter for that model.

export interface CapabilitySyncResult {
  /** Rows whose capability columns were changed, with what they became. */
  updated: { modelId: string; label: string; changes: Record<string, number> }[];
  /** Configured OpenRouter models the catalogue had nothing to say about —
   *  usually the same retired ids `validateModels` reports as missing. */
  unmatched: string[];
  catalogueReachable: boolean;
}

export async function syncModelCapabilities(accountId?: string): Promise<CapabilitySyncResult> {
  const live = await openRouterCatalogue();
  if (!live) return { updated: [], unmatched: [], catalogueReachable: false };
  if (!dbReady()) return { updated: [], unmatched: [], catalogueReachable: true };

  let q = supabase
    .from('ai_models')
    .select('id, label, model_id, context_window, max_output_tokens, cost_per_mtok_in, cost_per_mtok_out, ai_providers!inner(name, account_id)');
  if (accountId) q = q.eq('ai_providers.account_id', accountId);
  const { data, error } = await q;
  if (error) throw error;

  const updated: CapabilitySyncResult['updated'] = [];
  const unmatched: string[] = [];

  for (const row of (data || []) as any[]) {
    if (!/openrouter/i.test(row.ai_providers?.name || '')) continue;
    const entry = live.get(String(row.model_id || ''));
    if (!entry) { unmatched.push(String(row.model_id || '')); continue; }

    const changes: Record<string, number> = {};
    const set = (col: string, next: number | undefined, current: unknown) => {
      if (next === undefined) return;
      // Numeric columns come back as strings from some drivers; compare as
      // numbers so an unchanged value is not rewritten on every sync.
      if (current != null && Number(current) === next) return;
      changes[col] = next;
    };
    set('context_window', entry.contextWindow, row.context_window);
    set('max_output_tokens', entry.maxOutput, row.max_output_tokens);
    set('cost_per_mtok_in', entry.costInPerMTok, row.cost_per_mtok_in);
    set('cost_per_mtok_out', entry.costOutPerMTok, row.cost_per_mtok_out);

    if (!Object.keys(changes).length) continue;
    const { error: upErr } = await supabase.from('ai_models').update(changes).eq('id', row.id);
    if (upErr) throw upErr;
    updated.push({ modelId: String(row.model_id), label: row.label || String(row.model_id), changes });
  }

  return { updated, unmatched, catalogueReachable: true };
}

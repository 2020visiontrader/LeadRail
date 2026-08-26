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

/** OpenRouter publishes its full model list unauthenticated. */
async function openRouterCatalogue(): Promise<Set<string> | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const ids = (json?.data || []).map((m: any) => String(m?.id || '')).filter(Boolean);
    return ids.length ? new Set<string>(ids) : null;
  } catch {
    return null;
  }
}

/** Ids that share the family but not the exact name — a renamed or repriced
 *  variant is the commonest cause, so the base name before `:` is the useful
 *  thing to match on. */
function suggestionsFor(wanted: string, live: Set<string>): string[] {
  const base = wanted.split(':')[0].toLowerCase();
  const stem = base.split('/').pop() || base;
  // Progressively looser: exact family, then any id sharing a distinctive
  // chunk of the name.
  const family = [...live].filter((id) => id.toLowerCase().startsWith(base));
  if (family.length) return family.slice(0, 5);
  const parts = stem.split(/[-_.]/).filter((p) => p.length > 3);
  if (!parts.length) return [];
  return [...live]
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

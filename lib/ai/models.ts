// OpenCode Go model catalog + capability-based selection.
// Source of truth: GET https://opencode.ai/zen/go/v1/models (probed live).
// The Go endpoint exposes the open-weight fleet, all billed against the Go
// subscription (cost 0 per call). Hermes uses `pickModel(task)` to route each
// job to the cheapest model that clears the bar for it, instead of always
// paying the reasoning-model tax for a one-line rewrite.

export type TaskKind =
  | 'classify' // fast intent/routing decisions, short output
  | 'extract' // structured JSON extraction (ICP parse, deck profiling)
  | 'draft' // marketing/outreach copy, conversational replies
  | 'reason' // multi-step planning, sequence design, judgement
  | 'long' // long-context ingestion (whole deck / many rows)
  | 'code'; // structured/code-shaped output

export interface GoModel {
  id: string;
  label: string;
  // What this model is the right default for. First match wins in pickModel.
  good: TaskKind[];
  // Rough tier for display/telemetry: fast < balanced < heavy.
  tier: 'fast' | 'balanced' | 'heavy';
  reasoning?: boolean; // needs thinking:disabled to emit content (DeepSeek family)
}

// Curated from the live Go catalog. Not every listed id is mapped — these are
// the ones with a clear, defensible role. Unknown/new ids still work if passed
// via OPENCODE_MODEL, but Hermes only routes to models it understands.
export const GO_MODELS: GoModel[] = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', good: ['classify', 'draft'], tier: 'fast', reasoning: true },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', good: ['reason', 'extract'], tier: 'heavy', reasoning: true },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', good: ['code', 'extract'], tier: 'balanced' },
  { id: 'kimi-k3', label: 'Kimi K3', good: ['long', 'reason'], tier: 'heavy' },
  { id: 'qwen3.7-max', label: 'Qwen 3.7 Max', good: ['long', 'draft'], tier: 'balanced' },
  { id: 'glm-5.2', label: 'GLM 5.2', good: ['draft', 'classify'], tier: 'balanced' },
  { id: 'minimax-m3', label: 'MiniMax M3', good: ['long'], tier: 'balanced' },
  { id: 'grok-4.5', label: 'Grok 4.5', good: ['reason'], tier: 'heavy' },
];

// Default when nothing else matches — matches lib/ai/opencode default so
// behaviour is unchanged unless Hermes deliberately overrides.
export const DEFAULT_MODEL = 'deepseek-v4-pro';

const byId = new Map(GO_MODELS.map((m) => [m.id, m]));

export function getModel(id: string): GoModel | undefined {
  return byId.get(id);
}

/**
 * Pick the best Go model for a task kind. Prefers the fastest model whose
 * `good` list contains the kind (cost discipline), falling back to the default
 * reasoning model. Respecting an explicit env override keeps ops in control.
 */
export function pickModel(kind: TaskKind): string {
  const forced = process.env.OPENCODE_FORCE_MODEL;
  if (forced && byId.has(forced)) return forced;
  const tierRank = { fast: 0, balanced: 1, heavy: 2 } as const;
  const matches = GO_MODELS.filter((m) => m.good.includes(kind)).sort(
    (a, b) => tierRank[a.tier] - tierRank[b.tier],
  );
  return matches[0]?.id || DEFAULT_MODEL;
}

export function isReasoningModel(id: string): boolean {
  return byId.get(id)?.reasoning ?? /deepseek/i.test(id);
}

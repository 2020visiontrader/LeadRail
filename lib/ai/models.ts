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
  // What this model is auto-routed for. First (fastest) match wins in pickModel.
  // Only models proven to reliably return content on the current Go endpoint
  // carry routing tags; see `reliable` below.
  good: TaskKind[];
  // Rough tier for display/telemetry: fast < balanced < heavy.
  tier: 'fast' | 'balanced' | 'heavy';
  reasoning?: boolean; // emits hidden reasoning_content; DeepSeek accepts thinking:disabled
  // Reliability of non-empty content on this Go endpoint (probed 2026-07-30).
  // DeepSeek accepts `thinking:{type:disabled}` so its budget goes to the
  // answer. kimi/qwen/glm/minimax/grok reason uncontrollably here and return
  // EMPTY content on non-trivial prompts (and 500 on thinking:disabled), so
  // they are catalogued + selectable via OPENCODE_FORCE_MODEL but NOT
  // auto-routed until the endpoint exposes a thinking toggle for them.
  reliable: boolean;
}

// Curated from the live Go catalog. DeepSeek is the auto-routing backbone
// because it is the only family that reliably returns content today; the rest
// stay listed for visibility/telemetry and manual override.
export const GO_MODELS: GoModel[] = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', good: ['classify', 'draft'], tier: 'fast', reasoning: true, reliable: true },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', good: ['reason', 'extract', 'code', 'long'], tier: 'heavy', reasoning: true, reliable: true },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', good: [], tier: 'balanced', reasoning: true, reliable: false },
  { id: 'kimi-k3', label: 'Kimi K3', good: [], tier: 'heavy', reasoning: true, reliable: false },
  { id: 'qwen3.7-max', label: 'Qwen 3.7 Max', good: [], tier: 'balanced', reasoning: true, reliable: false },
  { id: 'glm-5.2', label: 'GLM 5.2', good: [], tier: 'balanced', reasoning: true, reliable: false },
  { id: 'minimax-m3', label: 'MiniMax M3', good: [], tier: 'balanced', reasoning: true, reliable: false },
  { id: 'grok-4.5', label: 'Grok 4.5', good: [], tier: 'heavy', reasoning: true, reliable: false },
];

// The reliable fallback any generator drops to if a chosen model returns empty.
export const RELIABLE_FALLBACK = 'deepseek-v4-pro';

// Default when nothing else matches in pickModel. NOT the same thing as
// lib/ai/opencode.ts's TEXT_MODEL, which moved to deepseek-v4-flash on
// 2026-09-02; this one is the heavy-task backstop and stays on pro, matching
// RELIABLE_FALLBACK above. (Every TaskKind is currently claimed by flash or
// pro, so this backstop is unreachable via pickModel today — it only bites if
// a future TaskKind is added with no `good` entry.)
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

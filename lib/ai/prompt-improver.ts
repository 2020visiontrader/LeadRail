// Prompt-improver layer — distilled from Skills/prompt-improver (5-Element
// Persona Framework + Claude/LLM 4.x optimizations). Pure functions: they build
// constraint-rich system/user scaffolding around a raw intent. No LLM calls here.

export interface Persona {
  role: string; // Role + seniority
  domain: string; // Industry / domain context
  methods: string; // Methodologies / frameworks
  constraints: string; // Budget / time / audience — the game-changer
  format: string; // Exact output shape
}

/** Assemble a 5-element persona into a system instruction. */
export function buildPersona(p: Persona): string {
  return [
    `You are ${p.role}.`,
    `Domain: ${p.domain}.`,
    `Methods: ${p.methods}.`,
    `Constraints: ${p.constraints}.`,
    `Output format: ${p.format}.`,
    `Be explicit and specific. No filler, no hedging, no meta-commentary.` +
      ` Match output exactly to the requested format. Write for the stated audience, not for a general reader.`,
  ].join('\n');
}

/**
 * Improve a raw user intent into a directive prompt: states the goal, the
 * concrete inputs, and the exact deliverable. Applied before every generation
 * call so shallow one-liners become structured requests.
 */
export function improvePrompt(opts: {
  goal: string;
  inputs: Record<string, string | undefined>;
  deliverable: string;
  rules?: string[];
}): string {
  const inputLines = Object.entries(opts.inputs)
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  const rules = (opts.rules ?? []).map((r) => `- ${r}`).join('\n');
  return [
    `GOAL: ${opts.goal}`,
    inputLines ? `INPUTS:\n${inputLines}` : '',
    rules ? `RULES:\n${rules}` : '',
    `DELIVERABLE: ${opts.deliverable}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

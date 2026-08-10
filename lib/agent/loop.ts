// LeadRail AI — the agentic tool-use loop.
//
// This is what makes LeadRail behave like a desktop AI assistant: the user
// types plain language, an LLM plans, calls LeadRail tools, sees the results,
// and continues until the task is done — all in-app.
//
// Provider-agnostic by design. "Your Claude" is reached through Zo Ask's
// text-in/text-out endpoint (no native tool-calling), so the loop uses a
// ReAct-style JSON protocol on top of the existing model ladder
// (lib/ai/router → Zo Ask/Claude → DeepSeek → NIM). The SAME loop works for
// every tier; the model just has to emit one JSON object per turn.
//
// Safety: sensitive tools (spend money / mutate external state) are NEVER
// auto-executed. The loop stops and returns a proposal; a human approves, and
// the caller resumes the loop with that one approved call. Account scope always
// comes from the server session — never from the (round-tripped) transcript.

import { generateChat, textConfigured, type ChatMessage } from '@/lib/ai/router';
import { TOOLS, runTool, toolCatalogForPrompt } from './tools';

const MAX_STEPS = 10;
const OBSERVATION_CHAR_LIMIT = 2000;

// The loop is latency-sensitive (a step per model round-trip), so it pins fast
// tiers instead of inheriting the account default (which may be a slow reasoning
// model). Zo Ask → Haiku (the standing Zo/Ask default for this account); if that
// tier errors, the router falls through to DeepSeek-Flash, then NIM. Override
// via AGENT_ZOASK_MODEL. JSON tool-routing is well within a fast model's ability.
const AGENT_ZOASK_MODEL = process.env.AGENT_ZOASK_MODEL || 'byok:d49f5f12-5edf-4121-8079-a34a9077ae77';
const AGENT_OPENCODE_MODEL = 'deepseek-v4-flash';

export interface AgentProposal {
  tool: string;
  title: string;
  args: Record<string, any>;
  summary: string;
}

export interface AgentStep {
  thought?: string;
  tool?: string;
  args?: Record<string, any>;
  observation?: string;
}

export type AgentStatus = 'done' | 'needs_approval' | 'error';

export interface AgentResult {
  status: AgentStatus;
  message: string;
  proposal?: AgentProposal;
  /** Full model transcript; pass back verbatim to resume after approval. */
  transcript: ChatMessage[];
  /** Human-readable trace for the UI. */
  steps: AgentStep[];
}

export interface RunAgentInput {
  accountId: string;
  message?: string;
  brandContext?: { name?: string };
  /** Prior transcript to resume from (returned by a needs_approval result). */
  transcript?: ChatMessage[];
  /** An approved sensitive call to execute before continuing the loop. */
  approve?: { tool: string; args: Record<string, any> };
}

export function agentConfigured(): boolean {
  return textConfigured();
}

function systemPrompt(brandName?: string): string {
  return [
    'You are LeadRail AI, the built-in assistant for the LeadRail platform (lead sourcing, outreach, and Meta ad campaigns).',
    brandName ? `The user is working in the "${brandName}" venture; prefer it when a venture is needed and not otherwise specified.` : '',
    '',
    'You accomplish tasks by calling LeadRail tools. On EACH turn respond with ONE JSON object and nothing else — no prose, no markdown fences. Use exactly one of these shapes:',
    '  {"thought":"<one short sentence>","action":"tool","tool":"<toolName>","args":{...}}',
    '  {"thought":"<one short sentence>","action":"final","message":"<the answer for the user>"}',
    '',
    'Rules:',
    '- Take one step at a time. After a tool runs you will receive its result as an OBSERVATION; use it to decide the next step.',
    '- Resolve names to ids with the list tools before acting (e.g. listVentures, listAdAccounts, listCampaigns).',
    '- Tools marked [needs approval] spend money or change live state. Call them when appropriate — the platform will pause and ask the user to confirm before anything actually runs. Do not ask for confirmation yourself in text; just call the tool.',
    '- NEVER call the same tool with the same arguments twice. If a tool already returned what you need, do NOT call it again — answer with action:"final".',
    '- When the task is complete, or if you need information only the user can give, use action:"final".',
    '- Speak to the user in plain language. NEVER mention internal tool names, vendors, model names, or third-party services (e.g. Apollo, Meta API internals) in a final message — refer to everything as LeadRail.',
    '',
    'AVAILABLE TOOLS:',
    toolCatalogForPrompt(),
  ].filter(Boolean).join('\n');
}

function summarizeProposal(tool: string, args: Record<string, any>): string {
  const t = TOOLS[tool];
  const title = t?.title || tool;
  if (tool === 'launchCampaign') {
    const budget = args.dailyBudget != null ? ` at $${args.dailyBudget}/day` : '';
    return `Launch a live paid campaign${budget}. This will start spending on Meta.`;
  }
  if (tool === 'pauseCampaign') return 'Pause a live campaign (stops spend).';
  if (tool === 'createCampaign') {
    const meta = args.channel === 'meta' ? ' and a PAUSED Meta campaign (no spend yet)' : '';
    return `Create the campaign "${args.name}"${meta}.`;
  }
  return `${title}: ${JSON.stringify(args)}`;
}

function extractJson(raw: string): any | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function truncate(s: string): string {
  return s.length > OBSERVATION_CHAR_LIMIT ? `${s.slice(0, OBSERVATION_CHAR_LIMIT)}… [truncated]` : s;
}

function observation(text: string): ChatMessage {
  return { role: 'user', content: `OBSERVATION: ${truncate(text)}` };
}

/**
 * Run (or resume) the agent loop. Returns when the agent produces a final
 * answer, needs approval for a sensitive tool, or exhausts its step budget.
 */
export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const { accountId, brandContext } = input;
  const system = systemPrompt(brandContext?.name);
  const messages: ChatMessage[] = [...(input.transcript || [])];
  const steps: AgentStep[] = [];

  if (input.message) messages.push({ role: 'user', content: input.message });

  // Resume path: execute the one approved sensitive call, then keep looping so
  // the agent can report the outcome. Re-validated by the tool's own schema;
  // account scope is the server session's, never the client's.
  if (input.approve) {
    const { tool, args } = input.approve;
    if (!TOOLS[tool]?.sensitive) {
      return { status: 'error', message: 'That action can no longer be approved.', transcript: messages, steps };
    }
    const res = await runTool(tool, accountId, args);
    const obs = res.ok ? JSON.stringify(res.result) : `ERROR: ${res.error}`;
    steps.push({ tool, args, observation: truncate(obs) });
    messages.push(observation(obs));
  }

  let corrected = false;
  const seen = new Set<string>();   // executed (tool+args) signatures — guards against re-calling the same read.
  let dupNudges = 0;
  const toolCalls: Record<string, number> = {};
  for (let i = 0; i < MAX_STEPS; i++) {
    let raw: string;
    try {
      raw = await generateChat({ system, messages, temperature: 0.2, maxOutputTokens: 700, zoAskModel: AGENT_ZOASK_MODEL, model: AGENT_OPENCODE_MODEL });
    } catch (e: any) {
      return { status: 'error', message: 'LeadRail AI is temporarily unavailable. Please try again.', transcript: messages, steps };
    }

    const parsed = extractJson(raw);
    if (!parsed || (parsed.action !== 'tool' && parsed.action !== 'final')) {
      if (!corrected) {
        corrected = true;
        messages.push({ role: 'user', content: 'Respond with ONLY one JSON object using the "tool" or "final" shape.' });
        continue;
      }
      return { status: 'error', message: "I couldn't complete that request. Please rephrase and try again.", transcript: messages, steps };
    }
    corrected = false;

    // Record the model's decision in the transcript so context carries forward.
    messages.push({ role: 'assistant', content: JSON.stringify(parsed) });

    if (parsed.action === 'final') {
      const message = String(parsed.message || '').trim() || 'Done.';
      steps.push({ thought: parsed.thought });
      return { status: 'done', message, transcript: messages, steps };
    }

    // action === 'tool'
    const tool = String(parsed.tool || '');
    const args = (parsed.args && typeof parsed.args === 'object') ? parsed.args : {};
    const def = TOOLS[tool];

    if (!def) {
      steps.push({ thought: parsed.thought, tool });
      messages.push(observation(`ERROR: unknown tool "${tool}".`));
      continue;
    }

    if (def.sensitive) {
      const proposal: AgentProposal = { tool, title: def.title, args, summary: summarizeProposal(tool, args) };
      steps.push({ thought: parsed.thought, tool, args });
      return { status: 'needs_approval', message: proposal.summary, proposal, transcript: messages, steps };
    }

    const sig = `${tool}:${JSON.stringify(args)}`;
    if (seen.has(sig)) {
      // Model is repeating a call it already ran. Don't re-execute — nudge it to
      // answer. If it keeps looping, break to the forced final below.
      if (++dupNudges >= 2) break;
      messages.push({ role: 'user', content: 'You already ran that and its result is in the OBSERVATION above. Do NOT call it again — answer now with action:"final".' });
      continue;
    }
    seen.add(sig);

    const res = await runTool(tool, accountId, args);
    const obs = res.ok ? JSON.stringify(res.result) : `ERROR: ${res.error}`;
    steps.push({ thought: parsed.thought, tool, args, observation: truncate(obs) });
    messages.push(observation(obs));
  }

  // Forced final: rather than surface a "too many steps" error, make one last
  // call that must answer in plain language from what was already gathered.
  try {
    messages.push({ role: 'user', content: 'Stop calling tools. Using the information above, answer the user now. Respond with ONLY {"action":"final","message":"..."}.' });
    const raw = await generateChat({ system, messages, temperature: 0.2, maxOutputTokens: 500, zoAskModel: AGENT_ZOASK_MODEL, model: AGENT_OPENCODE_MODEL });
    const p = extractJson(raw);
    if (p?.action === 'final' && p.message) return { status: 'done', message: String(p.message), transcript: messages, steps };
  } catch { /* fall through */ }
  return { status: 'error', message: 'I gathered the details but had trouble summarizing. Please ask again a bit more specifically.', transcript: messages, steps };
}

// --- Streaming variant -----------------------------------------------------
// Same ReAct loop, but emits each reasoning step as it happens so the UI can
// render a live, plain-language "thinking" trace (Claude-desktop style). The
// caller pipes these events over SSE. Approval still stops the loop: on a
// sensitive tool it emits `needs_approval` with the transcript to resume from.

export type AgentEvent =
  | { type: 'thought'; text: string }
  | { type: 'tool'; tool: string; title: string; args: Record<string, any> }
  | { type: 'observation'; text: string; ok: boolean }
  | { type: 'final'; message: string; transcript: ChatMessage[] }
  | { type: 'needs_approval'; proposal: AgentProposal; message: string; transcript: ChatMessage[] }
  | { type: 'error'; message: string };

export async function runAgentStream(input: RunAgentInput, emit: (e: AgentEvent) => void): Promise<void> {
  const { accountId, brandContext } = input;
  const system = systemPrompt(brandContext?.name);
  const messages: ChatMessage[] = [...(input.transcript || [])];

  if (input.message) messages.push({ role: 'user', content: input.message });

  if (input.approve) {
    const { tool, args } = input.approve;
    if (!TOOLS[tool]?.sensitive) { emit({ type: 'error', message: 'That action can no longer be approved.' }); return; }
    emit({ type: 'tool', tool, title: TOOLS[tool].title, args });
    const res = await runTool(tool, accountId, args);
    const obs = res.ok ? JSON.stringify(res.result) : `ERROR: ${res.error}`;
    emit({ type: 'observation', text: truncate(obs), ok: res.ok });
    messages.push(observation(obs));
  }

  let corrected = false;
  const seen = new Set<string>();
  let dupNudges = 0;
  const toolCalls: Record<string, number> = {};
  for (let i = 0; i < MAX_STEPS; i++) {
    let raw: string;
    try {
      raw = await generateChat({ system, messages, temperature: 0.2, maxOutputTokens: 700, zoAskModel: AGENT_ZOASK_MODEL, model: AGENT_OPENCODE_MODEL });
    } catch {
      emit({ type: 'error', message: 'LeadRail AI is temporarily unavailable. Please try again.' });
      return;
    }

    const parsed = extractJson(raw);
    if (!parsed || (parsed.action !== 'tool' && parsed.action !== 'final')) {
      if (!corrected) {
        corrected = true;
        messages.push({ role: 'user', content: 'Respond with ONLY one JSON object using the "tool" or "final" shape.' });
        continue;
      }
      emit({ type: 'error', message: "I couldn't complete that request. Please rephrase and try again." });
      return;
    }
    corrected = false;
    messages.push({ role: 'assistant', content: JSON.stringify(parsed) });

    if (parsed.thought) emit({ type: 'thought', text: String(parsed.thought) });

    if (parsed.action === 'final') {
      emit({ type: 'final', message: String(parsed.message || '').trim() || 'Done.', transcript: messages });
      return;
    }

    const tool = String(parsed.tool || '');
    const args = (parsed.args && typeof parsed.args === 'object') ? parsed.args : {};
    const def = TOOLS[tool];

    if (!def) {
      emit({ type: 'observation', text: `Unknown tool "${tool}".`, ok: false });
      messages.push(observation(`ERROR: unknown tool "${tool}".`));
      continue;
    }

    if (def.sensitive) {
      const proposal: AgentProposal = { tool, title: def.title, args, summary: summarizeProposal(tool, args) };
      emit({ type: 'needs_approval', proposal, message: proposal.summary, transcript: messages });
      return;
    }

    const sig = `${tool}:${JSON.stringify(args)}`;
    if (seen.has(sig) || (toolCalls[tool] || 0) >= 2) {
      // Exact repeat, or the same tool called too many times (e.g. pagination
      // churn). Don't re-run — nudge to answer; break to forced final if stuck.
      if (++dupNudges >= 2) break;
      messages.push({ role: 'user', content: 'You have enough from previous results. Do NOT call more tools — answer now with action:"final".' });
      continue;
    }
    seen.add(sig);
    toolCalls[tool] = (toolCalls[tool] || 0) + 1;

    emit({ type: 'tool', tool, title: def.title, args });
    const res = await runTool(tool, accountId, args);
    const obs = res.ok ? JSON.stringify(res.result) : `ERROR: ${res.error}`;
    emit({ type: 'observation', text: truncate(obs), ok: res.ok });
    messages.push(observation(obs));
  }

  // Forced final rather than a "too many steps" error.
  try {
    messages.push({ role: 'user', content: 'Stop calling tools. Using the information above, answer the user now. Respond with ONLY {"action":"final","message":"..."}.' });
    const raw = await generateChat({ system, messages, temperature: 0.2, maxOutputTokens: 500, zoAskModel: AGENT_ZOASK_MODEL, model: AGENT_OPENCODE_MODEL });
    const p = extractJson(raw);
    if (p?.action === 'final' && p.message) { emit({ type: 'final', message: String(p.message), transcript: messages }); return; }
  } catch { /* fall through */ }
  emit({ type: 'error', message: 'I gathered the details but had trouble summarizing. Please ask again a bit more specifically.' });
}

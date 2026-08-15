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
import { estimateTokens, carryoverBlock, type CarryoverMemo } from './memory';
import {
  loadPersonaForAgent, resolveMentionedPersonas, getCoordinator,
  buildPersonaSystemBlock, buildCoordinatorSystemBlock, type PersonaRow,
} from './personas';
import { loadEnabledSkillsForAgent } from '@/lib/skills/store';
import { createApproval, markApprovedByToolAndArgs } from '@/lib/approvals/store';

const MAX_STEPS = 10;
const OBSERVATION_CHAR_LIMIT = 2000;

// Long-chat handoff thresholds (token estimate over the running transcript).
// Soft → nudge the user to start a fresh chat (context carried over). Hard →
// the chat is large enough that quality degrades; tell them to switch now.
export const SOFT_TOKEN_LIMIT = Number(process.env.AGENT_SOFT_TOKENS || 24000);
export const HARD_TOKEN_LIMIT = Number(process.env.AGENT_HARD_TOKENS || 40000);

export function compactionLevel(tokenEstimate: number): 'soft' | 'hard' | null {
  if (tokenEstimate >= HARD_TOKEN_LIMIT) return 'hard';
  if (tokenEstimate >= SOFT_TOKEN_LIMIT) return 'soft';
  return null;
}

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
  /** Durable approvals row id (migration 028_approvals.sql), when persistence
   *  succeeded. ADDITIVE — the transcript-resume flow (input.approve) never
   *  depends on this; it's set best-effort so a UI can show a persisted queue
   *  and record actor/comment/no-self-approval/edit-invalidation. Absent if
   *  persistence failed (e.g. DB unavailable) — resume still works. */
  approvalId?: string;
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
  /** Rough token size of the transcript, for long-chat handoff. */
  tokenEstimate?: number;
  /** Set when the chat is large enough to suggest (soft) or urge (hard) a fresh one. */
  compaction?: 'soft' | 'hard' | null;
}

export interface RunAgentInput {
  accountId: string;
  message?: string;
  brandContext?: { name?: string };
  /** Full grounding block (platform + venture + account + memory) from loadAgentContext. */
  agentContext?: string;
  /** Carryover memo from a prior chat, injected to seed a reseeded conversation. */
  carryover?: CarryoverMemo | null;
  /** Prior transcript to resume from (returned by a needs_approval result). */
  transcript?: ChatMessage[];
  /** An approved sensitive call to execute before continuing the loop. */
  approve?: { tool: string; args: Record<string, any> };
  /** Optional persona (migration 024) to adopt for this turn. Omitted/undefined
   *  = today's default LeadRail AI behavior, unchanged. */
  personaId?: string;
  /** Optional @mention name tokens parsed from the user's message, used for
   *  multi-persona routing (see resolvePersonaForTurn below). Ignored when
   *  personaId is set — an explicit personaId always wins. */
  personaMentions?: string[];
  /** Actor email for the durable approvals audit trail (migration
   *  028_approvals.sql) — typically session.email from the calling route.
   *  Optional/additive: when omitted, a persisted approval is still created
   *  with requested_by = null (no self-approval guard until an actor is
   *  known); the existing needs_approval/resume contract is unaffected. */
  requestedBy?: string;
  /** Optional persisted-conversation id to associate with a durable approval
   *  row, when the caller already has one (e.g. a follow-up turn). */
  conversationId?: string;
}

export function agentConfigured(): boolean {
  return textConfigured();
}

// Build the enabled-skills system-prompt block (migration 025_skills.sql).
// Same shape/spirit as composeSkillGuidance (lib/skills/registry.ts) used by
// outreach generation: a short bullet list of "name: instructions". Returns
// '' when nothing is enabled, so callers can splice it in unconditionally.
function skillsBlock(skills: { name: string; instructions: string }[]): string {
  if (!skills.length) return '';
  return [
    'ENABLED SKILLS — apply this guidance when relevant to the current task:',
    ...skills.map((s) => `• ${s.name}: ${s.instructions}`),
  ].join('\n');
}

function systemPrompt(brandName?: string, agentContext?: string, carryover?: CarryoverMemo | null, personaBlock?: string, skillsGuidance?: string): string {
  return [
    'You are LeadRail AI — the operator copilot built into the LeadRail platform. Think of yourself the way a great chief-of-staff works: you understand the whole platform, you know this account and its ventures, you reason things through in plain language, and you actually DO the work by using LeadRail\'s tools. You are conversational and intellectually engaged — you can discuss strategy, weigh options, and explain your thinking, not just fire off tool calls.',
    '',
    // Persona override (migration 024) — absent for every call today, so this
    // is a no-op unless a caller explicitly passes personaId.
    personaBlock ? personaBlock + '\n' : '',
    // Enabled skills (migration 025) — absent when the account has none
    // enabled (the default), so this is a no-op for every account today.
    skillsGuidance ? skillsGuidance + '\n' : '',
    agentContext || (brandName ? `The user is working in the "${brandName}" venture; prefer it when a venture is needed and not otherwise specified.` : ''),
    carryover ? '\n' + carryoverBlock(carryover) : '',
    '',
    'HOW YOU RESPOND: on EACH turn output ONE JSON object and nothing else — no prose outside it, no markdown fences. Use exactly one shape:',
    '  {"thought":"<short plain-language sentence describing what you\'re doing/thinking>","action":"tool","tool":"<toolName>","args":{...}}',
    '  {"thought":"<short plain-language sentence>","action":"final","message":"<your full reply to the user>"}',
    'The "thought" is shown to the user live as your thinking step — write it as a human sentence ("Checking your active campaigns…"), never a raw tool name.',
    '',
    'HOW YOU WORK:',
    '- Ground every answer in this account\'s real data — use the context above and the tools; never invent numbers, leads, or campaigns.',
    '- To DO a task, call the tool for it. Resolve names to ids first with the list tools (listVentures, listAdAccounts, listCampaigns). Chain tools across turns to complete multi-step jobs.',
    '- Reads and safe internal writes run immediately. Tools marked [needs approval] spend money, send to real people, or are destructive — just call them; the platform pauses and asks the user to confirm before anything real happens. Do NOT ask for confirmation yourself in text; the call itself is the ask.',
    '- If a request is genuinely ambiguous in a way that changes the outcome, ask ONE focused clarifying question with action:"final". Otherwise make the reasonable call and proceed.',
    '- When you just need to talk — explain, advise, strategize, answer a question — use action:"final" with a substantive, warm, plain-language message. It is fine to answer directly without any tool when no action is needed.',
    '- NEVER call the same tool with the same arguments twice; if you already have the result, answer.',
    '- Speak only in plain language. NEVER mention internal tool names, vendors, model names, or third-party services (Apollo, Meta API internals, etc.) — everything is "LeadRail".',
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
  if (tool === 'sendEmail') return 'Send this email to a real lead now.';
  if (tool === 'enrollInSequence') {
    const n = Array.isArray(args.contactIds) ? args.contactIds.length : 0;
    return `Enroll ${n || 'the selected'} lead${n === 1 ? '' : 's'} into a follow-up sequence — they will start receiving scheduled emails.`;
  }
  if (tool === 'sourceLeads') return 'Search for new leads. This uses sourcing credits.';
  if (tool === 'enrichLead') return 'Reveal this lead\'s verified email and full profile. This uses sourcing credits.';
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

// Derive small, truthful per-run metrics from a tool's real result. Only counts
// what actually happened; unknown shapes yield {} (nothing shown). Drives the
// dock's "This run" domain KPIs — never fabricates.
function deriveMetrics(tool: string, args: Record<string, any>, result: any): Record<string, number> {
  const arrLen = (v: any): number | undefined =>
    Array.isArray(v) ? v.length
    : Array.isArray(v?.people) ? v.people.length
    : Array.isArray(v?.leads) ? v.leads.length
    : Array.isArray(v?.results) ? v.results.length
    : undefined;
  switch (tool) {
    case 'sourceLeads': { const n = arrLen(result); return n != null ? { leadsFound: n } : {}; }
    case 'enrichLead': return result ? { revealed: 1 } : {};
    case 'draftOutreach': return result ? { drafts: 1 } : {};
    case 'generateAdCopy': return result ? { copy: 1 } : {};
    case 'sendEmail': return { emailsSent: 1 };
    case 'enrollInSequence': { const n = Array.isArray(args?.contactIds) ? args.contactIds.length : 1; return { enrolled: n }; }
    case 'updateLeadStatus': return args?.status === 'qualified' ? { qualified: 1 } : {};
    case 'createDeal': return result ? { deals: 1 } : {};
    default: return {};
  }
}

// --- Persona resolution (migration 024) -------------------------------------
// Resolves which persona (if any) should frame this turn, and the model_id to
// pass through to generateChat. Every branch degrades to `{ persona: null,
// modelId: undefined }` on any lookup failure, so a stale id or an
// unconfigured roster NEVER breaks the turn — it just runs as the unchanged
// default. Returns at most one "active" persona: an explicit personaId always
// wins; otherwise a single @mention match is used directly; multiple mentions
// resolve to the account's coordinator (if enabled) so the reply is framed by
// one voice rather than several. This is the "lightweight synthesis" called
// for in the spec — the coordinator's instructions are what get prepended,
// not a separate multi-agent fan-out/merge pass (see TODO below).
async function resolvePersonaForTurn(
  accountId: string,
  personaId?: string,
  personaMentions?: string[],
): Promise<{ systemBlock?: string; modelId?: string }> {
  if (personaId) {
    const persona = await loadPersonaForAgent(accountId, personaId);
    if (!persona) return {};
    return { systemBlock: buildPersonaSystemBlock(persona), modelId: persona.model_id || undefined };
  }
  if (personaMentions && personaMentions.length) {
    try {
      const matched = await resolveMentionedPersonas(accountId, personaMentions);
      if (matched.length === 1) {
        const persona = matched[0];
        return { systemBlock: buildPersonaSystemBlock(persona), modelId: persona.model_id || undefined };
      }
      if (matched.length > 1) {
        // TODO(coordinator synthesis): a full pass would run each mentioned
        // persona's instructions independently and merge their outputs. That
        // multi-call fan-out doesn't fit safely inside the existing
        // single-transcript ReAct loop without risking MAX_STEPS/token
        // regressions, so for now the coordinator (if any) simply frames the
        // final answer while being told which personas were mentioned; if no
        // coordinator is configured, fall through to default (unchanged)
        // behavior rather than guessing which single persona should answer.
        const coordinator = await getCoordinator(accountId);
        if (coordinator) {
          const names = matched.map((p) => p.name).join(', ');
          const block = buildCoordinatorSystemBlock(coordinator) +
            `\nThe user @mentioned these personas: ${names}. Answer as the coordinator, drawing on what each persona would bring, and produce ONE unified reply.`;
          return { systemBlock: block, modelId: coordinator.model_id || undefined };
        }
      }
    } catch {
      /* fall through to default */
    }
  }
  return {};
}

/**
 * Run (or resume) the agent loop. Returns when the agent produces a final
 * answer, needs approval for a sensitive tool, or exhausts its step budget.
 */
export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const { accountId, brandContext } = input;
  const { systemBlock: personaBlock, modelId: personaModelId } = await resolvePersonaForTurn(accountId, input.personaId, input.personaMentions);
  const enabledSkills = await loadEnabledSkillsForAgent(accountId);
  const system = systemPrompt(brandContext?.name, input.agentContext, input.carryover, personaBlock, skillsBlock(enabledSkills));
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
    // Best-effort: reflect the resume-side approval into the durable approvals
    // table (migration 028_approvals.sql) so the persisted queue stays in
    // sync with the transcript-resume flow. Never blocks execution — the
    // resume/approve contract is unchanged even if this fails or the row was
    // never created (e.g. persistence was down when the proposal was made).
    try { await markApprovedByToolAndArgs(accountId, tool, args, input.requestedBy); } catch { /* never block execution */ }
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
      raw = await generateChat({
        system, messages, temperature: 0.2, maxOutputTokens: 700, zoAskModel: AGENT_ZOASK_MODEL, model: AGENT_OPENCODE_MODEL,
        // Only threaded through when a persona with a model override is active,
        // so the no-persona path calls generateChat with EXACTLY the same
        // options object shape as before this change.
        ...(personaModelId ? { accountId, modelId: personaModelId } : {}),
      });
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
      const tokenEstimate = estimateTokens(messages);
      return { status: 'done', message, transcript: messages, steps, tokenEstimate, compaction: compactionLevel(tokenEstimate) };
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
      // Additive: persist the proposal so it survives a closed tab and gets an
      // actor trail (migration 028_approvals.sql). Best-effort — a failure
      // here (e.g. DB unavailable) must never block the existing
      // needs_approval/resume flow, so approvalId is simply omitted.
      try {
        const row = await createApproval(accountId, {
          tool, title: def.title, summary: proposal.summary, args,
          conversationId: input.conversationId ?? null,
          requestedBy: input.requestedBy ?? null,
        });
        proposal.approvalId = row.id;
      } catch { /* never block the proposal on persistence failure */ }
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
    const raw = await generateChat({
      system, messages, temperature: 0.2, maxOutputTokens: 500, zoAskModel: AGENT_ZOASK_MODEL, model: AGENT_OPENCODE_MODEL,
      ...(personaModelId ? { accountId, modelId: personaModelId } : {}),
    });
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
  | { type: 'observation'; text: string; ok: boolean; tool?: string; metrics?: Record<string, number> }
  | { type: 'final'; message: string; transcript: ChatMessage[]; tokenEstimate?: number }
  | { type: 'needs_approval'; proposal: AgentProposal; message: string; transcript: ChatMessage[] }
  | { type: 'compaction_suggested'; level: 'soft' | 'hard'; tokenEstimate: number }
  | { type: 'error'; message: string };

export async function runAgentStream(input: RunAgentInput, emit: (e: AgentEvent) => void): Promise<void> {
  const { accountId, brandContext } = input;
  const { systemBlock: personaBlock, modelId: personaModelId } = await resolvePersonaForTurn(accountId, input.personaId, input.personaMentions);
  const enabledSkills = await loadEnabledSkillsForAgent(accountId);
  const system = systemPrompt(brandContext?.name, input.agentContext, input.carryover, personaBlock, skillsBlock(enabledSkills));
  const messages: ChatMessage[] = [...(input.transcript || [])];

  if (input.message) messages.push({ role: 'user', content: input.message });

  if (input.approve) {
    const { tool, args } = input.approve;
    if (!TOOLS[tool]?.sensitive) { emit({ type: 'error', message: 'That action can no longer be approved.' }); return; }
    // Best-effort mirror of the resume-side approval into the durable
    // approvals table — see the matching comment in runAgent above. Never
    // blocks execution.
    try { await markApprovedByToolAndArgs(accountId, tool, args, input.requestedBy); } catch { /* never block execution */ }
    emit({ type: 'tool', tool, title: TOOLS[tool].title, args });
    const res = await runTool(tool, accountId, args);
    const obs = res.ok ? JSON.stringify(res.result) : `ERROR: ${res.error}`;
    emit({ type: 'observation', text: truncate(obs), ok: res.ok, tool, metrics: res.ok ? deriveMetrics(tool, args, res.result) : {} });
    messages.push(observation(obs));
  }

  let corrected = false;
  const seen = new Set<string>();
  let dupNudges = 0;
  const toolCalls: Record<string, number> = {};
  for (let i = 0; i < MAX_STEPS; i++) {
    let raw: string;
    try {
      raw = await generateChat({
        system, messages, temperature: 0.2, maxOutputTokens: 700, zoAskModel: AGENT_ZOASK_MODEL, model: AGENT_OPENCODE_MODEL,
        ...(personaModelId ? { accountId, modelId: personaModelId } : {}),
      });
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
      const tokenEstimate = estimateTokens(messages);
      emit({ type: 'final', message: String(parsed.message || '').trim() || 'Done.', transcript: messages, tokenEstimate });
      const level = compactionLevel(tokenEstimate);
      if (level) emit({ type: 'compaction_suggested', level, tokenEstimate });
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
      // Additive persistence — see the matching comment in runAgent above.
      // Best-effort; never blocks the existing needs_approval/resume flow.
      try {
        const row = await createApproval(accountId, {
          tool, title: def.title, summary: proposal.summary, args,
          conversationId: input.conversationId ?? null,
          requestedBy: input.requestedBy ?? null,
        });
        proposal.approvalId = row.id;
      } catch { /* never block the proposal on persistence failure */ }
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
    emit({ type: 'observation', text: truncate(obs), ok: res.ok, tool, metrics: res.ok ? deriveMetrics(tool, args, res.result) : {} });
    messages.push(observation(obs));
  }

  // Forced final rather than a "too many steps" error.
  try {
    messages.push({ role: 'user', content: 'Stop calling tools. Using the information above, answer the user now. Respond with ONLY {"action":"final","message":"..."}.' });
    const raw = await generateChat({
      system, messages, temperature: 0.2, maxOutputTokens: 500, zoAskModel: AGENT_ZOASK_MODEL, model: AGENT_OPENCODE_MODEL,
      ...(personaModelId ? { accountId, modelId: personaModelId } : {}),
    });
    const p = extractJson(raw);
    if (p?.action === 'final' && p.message) { emit({ type: 'final', message: String(p.message), transcript: messages }); return; }
  } catch { /* fall through */ }
  emit({ type: 'error', message: 'I gathered the details but had trouble summarizing. Please ask again a bit more specifically.' });
}

// --- Long-chat handoff: carryover generation -------------------------------
// Distill a full transcript into a compact carryover memo (fixed schema) so a
// fresh chat can be seeded without the raw history. Uses the same fast model
// ladder as the loop — this is a cheap single call, not a reasoning turn.

const CARRYOVER_SYSTEM = [
  'You compress a work chat between a user and the LeadRail operator copilot into a compact handoff memo so a NEW chat can continue seamlessly.',
  'Output ONE JSON object and nothing else, with these keys (omit any you cannot fill):',
  '{"objective":"<what the user is ultimately trying to achieve>",',
  ' "active_context":"<current venture + ids, active campaign ids, ad account — concrete>",',
  ' "established_facts":["<facts already learned: budgets, ICP, statuses>"],',
  ' "decisions":["<what was decided or approved>"],',
  ' "open_tasks":["<what still needs doing next>"],',
  ' "dont_repeat":["<work already completed, so the new chat does not redo it>"]}',
  'Be terse and concrete. No prose outside the JSON.',
].join('\n');

export async function generateCarryover(transcript: ChatMessage[]): Promise<CarryoverMemo> {
  const convo = transcript
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n')
    .slice(-16000); // last slice is the most relevant; keep the call cheap
  try {
    const raw = await generateChat({
      system: CARRYOVER_SYSTEM,
      messages: [{ role: 'user', content: `Transcript to compress:\n${convo}` }],
      temperature: 0.1,
      maxOutputTokens: 700,
      zoAskModel: AGENT_ZOASK_MODEL,
      model: AGENT_OPENCODE_MODEL,
    });
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const arr = (v: any) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined);
    return {
      objective: typeof parsed.objective === 'string' ? parsed.objective : undefined,
      active_context: typeof parsed.active_context === 'string' ? parsed.active_context : undefined,
      established_facts: arr(parsed.established_facts),
      decisions: arr(parsed.decisions),
      open_tasks: arr(parsed.open_tasks),
      dont_repeat: arr(parsed.dont_repeat),
    };
  } catch {
    return {};
  }
}

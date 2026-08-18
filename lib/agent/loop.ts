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
import { TOOLS, runTool, toolCatalogForPrompt, toolCatalogStaged, AGENT_STAGED_CATALOG, capabilityFor } from './tools';
import { estimateTokens, carryoverBlock, type CarryoverMemo } from './memory';
import {
  loadPersonaForAgent, resolveMentionedPersonas, getCoordinator,
  buildPersonaSystemBlock, buildCoordinatorSystemBlock, type PersonaRow,
} from './personas';
import { loadEnabledSkillsForAgent } from '@/lib/skills/store';
import { composeAnswer } from './compose';
import { createApproval, consumeApprovalForExecution, ApprovalExecutionError } from '@/lib/approvals/store';

const MAX_STEPS = 10;
// Two-pass output (Packet 8.1). The route pass below stays at temp 0.2 / 700
// tokens behind a JSON envelope — correct for tool selection, poor for prose.
// A second compose pass writes what the user actually reads. Set AGENT_COMPOSE=0
// to revert to shipping the route pass's draft verbatim.
const AGENT_COMPOSE = process.env.AGENT_COMPOSE !== '0';
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
  /** An approved sensitive call to execute before continuing the loop.
   *  approvalId is REQUIRED (Packet 0.1): execution is gated on a persisted
   *  approvals row being in state 'approved' with a matching args hash, and
   *  consuming it is single-use. Without this the transcript-resume flow would
   *  execute a REJECTED proposal if the same {tool,args} were resubmitted. */
  approve?: { approvalId: string; tool: string; args: Record<string, any> };
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
  /** Optional override of MAX_STEPS for THIS call only (Packet 6.2). Used
   *  exclusively to give each delegate in a coordinator fan-out a smaller
   *  step budget than a normal top-level turn — never set by ordinary
   *  callers, so every existing caller keeps the unchanged MAX_STEPS cap.
   *  Clamped to [1, MAX_STEPS]; never allows a LARGER budget than default. */
  maxSteps?: number;
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

// PROMPT BLOCK ORDER IS LOAD-BEARING (Packet 10.2 Part A) — do not rearrange.
//
// Everything static for an account comes FIRST; everything volatile comes LAST:
//
//   identity → personaBlock → skillsGuidance → HOW YOU RESPOND → HOW YOU WORK
//            → tool catalog → agentContext → carryover
//
// Prompt caching keys on a stable *prefix*: every byte after the first volatile
// byte is uncacheable. `agentContext` (loadAgentContext is query-specific) and
// `carryover` change per turn; `HOW YOU WORK` and the tool catalog are the two
// largest blocks here and are identical on every turn for an account. With the
// volatile blocks in the middle — where they used to sit — the biggest static
// content was the least cacheable part of the prompt.
//
// LeadRail does NOT implement provider-side prompt caching yet. This ordering
// makes the prefix *cacheable*; enabling caching is a separate change in
// lib/ai/providers.ts and is deliberately out of scope here. Reordering these
// blocks back also changes what the model attends to most strongly (recency),
// so it is a behaviour change, not a cosmetic one — do not do it casually.
function systemPrompt(brandName?: string, agentContext?: string, carryover?: CarryoverMemo | null, personaBlock?: string, skillsGuidance?: string): string {
  return [
    // ---- STATIC (stable across every turn for an account) -------------------
    'You are LeadRail AI — the operator copilot built into the LeadRail platform. Think of yourself the way a great chief-of-staff works: you understand the whole platform, you know this account and its ventures, you reason things through in plain language, and you actually DO the work by using LeadRail\'s tools. You are conversational and intellectually engaged — you can discuss strategy, weigh options, and explain your thinking, not just fire off tool calls.',
    '',
    // Persona override (migration 024) — absent for every call today, so this
    // is a no-op unless a caller explicitly passes personaId.
    personaBlock ? personaBlock + '\n' : '',
    // Enabled skills (migration 025) — absent when the account has none
    // enabled (the default), so this is a no-op for every account today.
    skillsGuidance ? skillsGuidance + '\n' : '',
    '',
    'HOW YOU RESPOND: on EACH turn output ONE JSON object and nothing else — no prose outside it, no markdown fences. Use exactly one shape:',
    '  {"thought":"<short plain-language sentence describing what you\'re doing/thinking>","action":"tool","tool":"<toolName>","args":{...}}',
    '  {"thought":"<short plain-language sentence>","action":"final","message":"<your full reply to the user>"}',
    'The "thought" is shown to the user live as your thinking step — write it as a human sentence ("Checking your active campaigns…"), never a raw tool name.',
    'You MAY split that one field into two, in either shape — both are optional and either may be omitted:',
    '  "plan": your own internal reasoning about what to do next. It is NEVER shown to the user, so be as technical as you like.',
    '  "narration": the single line the user reads instead of "thought". Short, plain language, present tense, no tool, vendor, or model names ("Pulling this month\'s numbers…").',
    'When "narration" is present it replaces "thought" in the live trace. When it is absent, "thought" is used exactly as described above — so omitting both new fields is always safe.',
    '',
    'HOW YOU WORK:',
    '- Ground every answer in this account\'s real data — use the context above and the tools; never invent numbers, leads, or campaigns.',
    '- To DO a task, call the tool for it. Resolve names to ids first with the list tools (listVentures, listAdAccounts, listCampaigns). Chain tools across turns to complete multi-step jobs.',
    '- Reads and safe internal writes run immediately. Tools marked [needs approval] spend money, send to real people, or are destructive — just call them; the platform pauses and asks the user to confirm before anything real happens. Do NOT ask for confirmation yourself in text; the call itself is the ask.',
    '- If a request is genuinely ambiguous in a way that changes the outcome, ask ONE focused clarifying question with action:"final". Otherwise make the reasonable call and proceed.',
    '- When you just need to talk — explain, advise, strategize, answer a question — use action:"final" with a substantive, warm, plain-language message. It is fine to answer directly without any tool when no action is needed.',
    '- When the user tells you something durable about them, their ventures, or their preferences, call rememberFact so you know it next time. Never remember secrets, credentials, or one-off task detail.',
    '- NEVER call the same tool with the same arguments twice; if you already have the result, answer.',
    '- Speak only in plain language. NEVER mention internal tool names, vendors, model names, or third-party services (Apollo, Meta API internals, etc.) — everything is "LeadRail".',
    '',
    // Two-stage tool catalog (Packet 10.3). Default (flag unset) is the full
    // catalog, byte-identical to what shipped before this packet. With
    // AGENT_STAGED_CATALOG=1 the route pass sees a compact per-domain index
    // instead and expands one domain at a time with describeTools.
    ...(AGENT_STAGED_CATALOG
      ? [
          'AVAILABLE TOOLS — grouped by domain, names only. Before calling a tool whose arguments you have not been shown, call describeTools with that domain to get its full signatures. Tools marked [needs approval] still pause for the user to confirm.',
          toolCatalogStaged(),
        ]
      : [
          'AVAILABLE TOOLS:',
          toolCatalogForPrompt(),
        ]),
    // ---- VOLATILE (changes per turn — nothing static may follow) ------------
    // Both blocks below are per-turn grounding. They are LAST on purpose; see
    // the PROMPT BLOCK ORDER note above before moving either of them.
    '',
    agentContext || (brandName ? `The user is working in the "${brandName}" venture; prefer it when a venture is needed and not otherwise specified.` : ''),
    carryover ? '\n' + carryoverBlock(carryover) : '',
  ].filter(Boolean).join('\n');
}

function summarizeProposal(tool: string, args: Record<string, any>): string {
  // A capability may supply its own summary (Packet 2.1). None do today, so
  // every existing branch below still fires and output is unchanged; later
  // packets add `summarize` so this branch list stops growing.
  const cap = capabilityFor(tool);
  if (cap?.summarize) return cap.summarize(args);
  const t = TOOLS[tool];
  const title = t?.title || tool;
  if (tool === 'launchCampaign') {
    const budget = args.dailyBudget != null ? ` at $${args.dailyBudget}/day` : '';
    return `Launch a live paid campaign${budget}. This will start spending on Meta.`;
  }
  // NO pauseCampaign branch, deliberately (Packet 1.3). Pausing STOPS spend, so
  // it stays non-sensitive (`gate: 'internal_write'`, lib/capabilities/campaigns.ts)
  // and runs immediately — it never reaches an approval card, so a summary here
  // would be dead code. If you are tempted to re-add it, change the gate first.
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

/** The user-facing line for one route-pass envelope (Packet 10.2 Part B).
 *
 *  The route pass used to make `thought` do two jobs: the model's private
 *  reasoning AND the sentence the user reads in the live trace — both inside
 *  one 700-token envelope at a temperature picked for routing accuracy. The
 *  protocol now offers `plan` (private) and `narration` (public) as an optional
 *  split.
 *
 *  `plan` is deliberately NOT consulted here. It reaches the model again only
 *  via the transcript (the whole envelope is stringified into `messages`), which
 *  is server-side continuity; it must never reach a client. This function is the
 *  ONLY way either loop derives a user-visible line, so there is exactly one
 *  place to audit that.
 *
 *  Backward compatibility is unconditional, not best-effort: with `narration`
 *  absent — every model response before this packet, and any model that ignores
 *  the new field — this returns `parsed.thought` untouched, so both call sites
 *  behave byte-for-byte as they did before.
 *
 *  BOTH runAgent and runAgentStream must call this. Their parsing of the
 *  envelope is required to be identical (runAgent has no `emit`, so it records
 *  the line into `steps` instead of emitting it).
 */
function narrationFor(parsed: any): string | undefined {
  const n = parsed?.narration;
  if (typeof n === 'string' && n.trim() !== '') return n;
  return parsed?.thought;
}

function truncate(s: string): string {
  return s.length > OBSERVATION_CHAR_LIMIT ? `${s.slice(0, OBSERVATION_CHAR_LIMIT)}… [truncated]` : s;
}

function observation(text: string): ChatMessage {
  return { role: 'user', content: `OBSERVATION: ${truncate(text)}` };
}

// Build the observation body for a SUCCESSFUL tool run (Packet 10.1).
//
// A capability may declare `digest(args, result)` — a short, truthful,
// plain-language rendering of its own result. When it does, the digest goes
// FIRST and the raw JSON follows, under the same single `OBSERVATION:` prefix
// that compose.ts scrapes. That ordering is the whole point: truncate() (here)
// and compose's 6000-char cap both cut from the end, so the digest survives
// while the JSON is what gets clipped.
//
// A capability WITHOUT a digest produces `JSON.stringify(result)` exactly as
// before — byte-identical, no separator, no wrapper.
//
// A digest that throws is treated as absent. This is a best-effort presentation
// hook, never a gate: a bad digest must degrade to today's raw-JSON behaviour,
// not fail the tool call whose result the user is waiting on.
function successObservation(tool: string, args: any, result: any): string {
  const raw = JSON.stringify(result);
  let digest = '';
  try {
    digest = (capabilityFor(tool)?.digest?.(args, result) || '').trim();
  } catch {
    digest = '';
  }
  return digest ? `${digest}\n${raw}` : raw;
}

/** The single observation-building path shared by runAgent and runAgentStream.
 *  Both loops MUST call this — they are required to stay identical here. */
function observationFor(tool: string, args: any, res: { ok: boolean; result?: any; error?: string }): string {
  return res.ok ? successObservation(tool, args, res.result) : `ERROR: ${res.error}`;
}

// PORTED (Packet 2.1 step 5): the per-tool deriveMetrics switch that used to
// live here now lives with each capability (lib/capabilities/metrics-port.ts,
// attached in registry.ts). Call sites read capabilityFor(tool)?.metrics, so
// adding a capability no longer requires editing this file. Behaviour is
// unchanged: unknown tools yield {} exactly as the old `default` did.

// --- Persona resolution (migration 024) -------------------------------------
// Resolves which persona (if any) should frame this turn, and the model_id to
// pass through to generateChat. Every branch degrades to `{ persona: null,
// modelId: undefined }` on any lookup failure, so a stale id or an
// unconfigured roster NEVER breaks the turn — it just runs as the unchanged
// default. Returns at most one "active" persona: an explicit personaId always
// wins; otherwise a single @mention match is used directly; multiple mentions
// resolve to the account's coordinator (if enabled) so the reply is framed by
// one voice rather than several.
//
// Packet 6.2 added the REAL multi-agent fan-out (runCoordinatorFanout /
// runCoordinatorFanoutStream, above runAgent/runAgentStream): runAgent and
// runAgentStream check resolveCoordinatorFanout() BEFORE ever calling this
// function, and take that path instead whenever it applies. The
// matched.length > 1 branch below is what still runs when that primary path
// declines — no coordinator configured, or a lookup error inside
// resolveCoordinatorFanout — so it stays a lightweight framing-only fallback,
// not the real thing: it does NOT run each persona independently, it only
// tells the coordinator model which names were mentioned and asks it to
// answer as if synthesizing them. That fallback intentionally does not
// fabricate more than it already did — it is the pre-6.2 behavior, unchanged.
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
// Map an execution-gate failure to a plain-language refusal. Never leaks state
// names or ids to the user; the audit trail carries the detail.
function approvalRefusal(e: any): string {
  switch (e?.code) {
    case 'not_approved':     return 'That action has not been approved (or was rejected), so I did not run it.';
    case 'already_executed': return 'That action was already carried out — I did not repeat it.';
    case 'args_mismatch':    return 'The details changed since you approved that, so I did not run it. Ask me to propose it again.';
    default:                 return 'I could not verify that this action was approved, so I did not run it.';
  }
}

/**
 * Defensive bound on the reloaded transcript. NOT a security control — the
 * transcript is server-owned state (loaded from `agent_conversations` by
 * account), so nothing here is attacker-supplied. It is belt-and-braces only:
 * a long-lived conversation can still grow past what a model call can carry,
 * and this drops the oldest turns until the estimate is back under bound.
 */
function capTranscript(transcript: ChatMessage[]): ChatMessage[] {
  const bound = HARD_TOKEN_LIMIT * 2;
  const messages = [...transcript];
  while (messages.length > 1 && estimateTokens(messages) > bound) messages.shift();
  return messages;
}

// --- Coordinator fan-out (Packet 6.2) ---------------------------------------
//
// `personas.is_coordinator` (migration 024) has existed since Packet 5.x with
// nothing reading it. This is that reader: when a turn @mentions 2+ enabled
// personas AND the account has an enabled coordinator, the turn is no longer
// framed by a single persona — it is answered by running each mentioned
// persona as its OWN independent runAgent() call (a "delegate"), then having
// the coordinator persona synthesize their actual outputs into one reply.
//
// Design constraints (binding, see COPILOT_REMEDIATION_PLAN.md Packet 6.2):
//   1. Delegation must not multiply spend or approvals. Every delegate is a
//      normal runAgent() call, so every tool it invokes still funnels through
//      runTool() (lib/agent/tools.ts) — the SAME sensitive-tool approval gate
//      (0.1) and the SAME monthly spend gate (1.4) apply, unmodified. If any
//      delegate proposes a sensitive tool, the WHOLE fan-out stops right there
//      and that one proposal is returned as the turn's result — no other
//      delegate keeps running while a human decision is outstanding, so one
//      coordinator turn can never produce more than one pending approval.
//   2. Bounded fan-out. MAX_FANOUT_DELEGATES caps how many personas one turn
//      may delegate to; MAX_FANOUT_TOTAL_STEPS is a hard ceiling on the SUM of
//      every delegate's own step budget (each delegate gets its own slice via
//      the `maxSteps` override added above — never more than MAX_STEPS, never
//      more than what's left of the shared budget). An account cannot turn a
//      single message into an unbounded number of model/tool round-trips by
//      mentioning many personas.
//   3. Synthesis must not fabricate. The coordinator's synthesis pass is given
//      ONLY the delegates' actual returned messages and is explicitly told not
//      to invent a result a delegate did not produce (mirrors the OBSERVATION
//      discipline from Packet 10.1's digest hook). A delegate that errors is
//      reported as a failure, never silently dropped or guessed at.
//   4. No scope widening. Every delegate call passes the SAME accountId as the
//      coordinator turn — there is no parameter by which a delegate could
//      target a different account.

/** One delegate's finished run — enough to attribute + synthesize honestly. */
interface DelegateOutcome {
  persona: PersonaRow;
  status: AgentStatus;
  message: string;
  stepsUsed: number;
}

const MAX_FANOUT_DELEGATES = 3;
const MAX_FANOUT_STEPS_PER_DELEGATE = 4;
const MAX_FANOUT_TOTAL_STEPS = MAX_FANOUT_DELEGATES * MAX_FANOUT_STEPS_PER_DELEGATE; // hard ceiling, constraint (2) above

/** Detect a fan-out turn: 2+ @mentioned enabled personas AND an enabled
 *  coordinator configured for the account. Returns null (never throws) for
 *  every other case, so the caller falls back to today's single-persona /
 *  framing-only behavior in resolvePersonaForTurn unchanged. */
async function resolveCoordinatorFanout(
  accountId: string,
  personaMentions?: string[],
): Promise<{ coordinator: PersonaRow; delegates: PersonaRow[] } | null> {
  if (!personaMentions || personaMentions.length < 2) return null;
  try {
    const matched = await resolveMentionedPersonas(accountId, personaMentions);
    if (matched.length < 2) return null;
    const coordinator = await getCoordinator(accountId);
    if (!coordinator) return null;
    return { coordinator, delegates: matched };
  } catch {
    return null;
  }
}

/** Run each delegate persona as its own bounded runAgent() call, sequentially,
 *  stopping immediately (constraint 1) if any delegate needs approval. Every
 *  delegate shares the same accountId, message, and agentContext as the
 *  coordinator turn — each reasons independently and does not see the others'
 *  tool calls, only the same starting request. */
async function runFanoutDelegates(
  accountId: string,
  personas: PersonaRow[],
  input: RunAgentInput,
): Promise<{ outcomes: DelegateOutcome[]; needsApproval?: AgentResult }> {
  const delegates = personas.slice(0, MAX_FANOUT_DELEGATES); // constraint (2)
  const outcomes: DelegateOutcome[] = [];
  let stepsUsed = 0;

  for (const persona of delegates) {
    const remaining = MAX_FANOUT_TOTAL_STEPS - stepsUsed;
    if (remaining <= 0) break; // shared step budget exhausted — stop, do not exceed it
    const stepBudget = Math.min(MAX_FANOUT_STEPS_PER_DELEGATE, remaining);

    const result = await runAgent({
      accountId,                 // constraint (4) — never a different account
      message: input.message,
      agentContext: input.agentContext,
      personaId: persona.id,
      maxSteps: stepBudget,
      requestedBy: input.requestedBy,
      conversationId: input.conversationId,
      // Deliberately no `transcript`/`carryover`/`approve` here: a delegate
      // is a fresh, self-contained sub-turn, not a resume of the coordinator's
      // own conversation.
    });
    stepsUsed += result.steps.length;

    if (result.status === 'needs_approval') {
      return { outcomes, needsApproval: result }; // constraint (1) — stop the whole fan-out
    }
    outcomes.push({
      persona,
      status: result.status,
      message: result.message,
      stepsUsed: result.steps.length,
    });
  }
  return { outcomes };
}

/** Synthesize the coordinator's final reply strictly from what the delegates
 *  actually returned (constraint 3). Falls back to a plain concatenation of
 *  the delegate outputs on any synthesis failure — never drops a delegate's
 *  result, never invents one. */
async function synthesizeCoordinatorAnswer(
  accountId: string,
  coordinator: PersonaRow,
  outcomes: DelegateOutcome[],
  userMessage?: string,
): Promise<string> {
  if (!outcomes.length) {
    return "None of the mentioned team members were able to respond, so I don't have anything grounded to report.";
  }
  const block = outcomes
    .map((o) => `### ${o.persona.name}${o.status === 'error' ? ' — FAILED' : ''}\n${o.message}`)
    .join('\n\n');
  const system = [
    buildCoordinatorSystemBlock(coordinator),
    '',
    'CRITICAL — grounding rule: base this synthesis ONLY on the delegate responses below. Never invent, assume, or add a result a delegate did not actually produce. If a delegate failed, say so honestly instead of guessing what they would have said. Reconcile overlaps and disagreements; do not just concatenate.',
  ].join('\n');
  try {
    const raw = await generateChat({
      system,
      messages: [{
        role: 'user',
        content: `User's request: ${userMessage || '(none)'}\n\nDelegate responses:\n${block}\n\nWrite the single unified final answer for the user now. Plain language, no JSON, no markdown headers.`,
      }],
      temperature: 0.3,
      maxOutputTokens: 800,
      zoAskModel: AGENT_ZOASK_MODEL,
      model: AGENT_OPENCODE_MODEL,
      ...(coordinator.model_id ? { accountId, modelId: coordinator.model_id } : {}),
    });
    const trimmed = raw.trim();
    return trimmed || block;
  } catch {
    return block; // never silently drop the delegates' actual outputs
  }
}

/** The runAgent-side fan-out path: gather delegate outcomes, then synthesize
 *  or bubble up a pending approval, and return exactly the AgentResult shape
 *  runAgent already promises callers. */
async function runCoordinatorFanout(
  accountId: string,
  fanout: { coordinator: PersonaRow; delegates: PersonaRow[] },
  input: RunAgentInput,
): Promise<AgentResult> {
  const messages: ChatMessage[] = capTranscript(input.transcript || []);
  const steps: AgentStep[] = [];
  if (input.message) messages.push({ role: 'user', content: input.message });

  const { outcomes, needsApproval } = await runFanoutDelegates(accountId, fanout.delegates, input);
  for (const o of outcomes) {
    steps.push({
      thought: `${o.persona.name} ${o.status === 'error' ? 'ran into an error' : 'responded'}.`,
      observation: truncate(o.message),
    });
  }
  if (needsApproval) return needsApproval; // constraint (1) — a delegate's own pending approval IS the turn's result

  const answer = await synthesizeCoordinatorAnswer(accountId, fanout.coordinator, outcomes, input.message);
  messages.push({ role: 'assistant', content: answer });
  const tokenEstimate = estimateTokens(messages);
  return { status: 'done', message: answer, transcript: messages, steps, tokenEstimate, compaction: compactionLevel(tokenEstimate) };
}

/** The runAgentStream-side fan-out path: same delegate/synthesis logic as
 *  runCoordinatorFanout, but emits live events instead of accumulating
 *  `steps`, matching the emit-channel divergence already documented on the
 *  LOOP-CONTROL INVARIANT above (delegates are not sub-streamed — a fan-out
 *  turn does not get token-by-token deltas from each delegate's own internal
 *  loop, only a "consulting X" thought and X's finished observation; the
 *  synthesis itself is emitted as one final message, not streamed token by
 *  token — a deliberate simplification, not a divergence in loop control). */
async function runCoordinatorFanoutStream(
  accountId: string,
  fanout: { coordinator: PersonaRow; delegates: PersonaRow[] },
  input: RunAgentInput,
  emit: (e: AgentEvent) => void,
): Promise<void> {
  const messages: ChatMessage[] = capTranscript(input.transcript || []);
  if (input.message) messages.push({ role: 'user', content: input.message });

  const delegates = fanout.delegates.slice(0, MAX_FANOUT_DELEGATES);
  for (const p of delegates) emit({ type: 'thought', text: `Consulting ${p.name}…` });

  const { outcomes, needsApproval } = await runFanoutDelegates(accountId, fanout.delegates, input);
  for (const o of outcomes) {
    emit({ type: 'observation', text: truncate(o.message), ok: o.status !== 'error' });
  }
  if (needsApproval) {
    emit({ type: 'needs_approval', proposal: needsApproval.proposal!, message: needsApproval.message, transcript: needsApproval.transcript });
    return;
  }

  emit({ type: 'thought', text: 'Synthesizing a unified answer…' });
  const answer = await synthesizeCoordinatorAnswer(accountId, fanout.coordinator, outcomes, input.message);
  messages.push({ role: 'assistant', content: answer });
  const tokenEstimate = estimateTokens(messages);
  emit({ type: 'final', message: answer, transcript: messages, tokenEstimate });
  const level = compactionLevel(tokenEstimate);
  if (level) emit({ type: 'compaction_suggested', level, tokenEstimate });
}

export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const { accountId, brandContext } = input;
  // Packet 6.2: only ever enter fan-out on a fresh turn — never mid-resume
  // (input.approve set) and never when the caller already pinned a single
  // explicit personaId. A resumed approval always finishes as one ordinary
  // step in the normal single-persona loop below, never a fresh fan-out —
  // that is what keeps "approve one action" from ever re-triggering N more.
  if (!input.approve && !input.personaId) {
    const fanout = await resolveCoordinatorFanout(accountId, input.personaMentions);
    if (fanout) return runCoordinatorFanout(accountId, fanout, input);
  }
  const { systemBlock: personaBlock, modelId: personaModelId } = await resolvePersonaForTurn(accountId, input.personaId, input.personaMentions);
  const enabledSkills = await loadEnabledSkillsForAgent(accountId);
  const system = systemPrompt(brandContext?.name, input.agentContext, input.carryover, personaBlock, skillsBlock(enabledSkills));
  const messages: ChatMessage[] = capTranscript(input.transcript || []);
  const steps: AgentStep[] = [];

  if (input.message) messages.push({ role: 'user', content: input.message });

  // Resume path: execute the one approved sensitive call, then keep looping so
  // the agent can report the outcome. Re-validated by the tool's own schema;
  // account scope is the server session's, never the client's.
  if (input.approve) {
    const { approvalId, tool, args } = input.approve;
    if (!TOOLS[tool]?.sensitive) {
      return { status: 'error', message: 'That action can no longer be approved.', transcript: messages, steps };
    }
    // HARD GATE (Packet 0.1): consume a persisted, approved, args-matching,
    // not-yet-executed approval. Failure MUST refuse — never fall through.
    try {
      await consumeApprovalForExecution(accountId, approvalId, tool, args);
    } catch (e: any) {
      return { status: 'error', message: approvalRefusal(e), transcript: messages, steps };
    }
    const res = await runTool(tool, accountId, args);
    const obs = observationFor(tool, args, res);
    steps.push({ tool, args, observation: truncate(obs) });
    messages.push(observation(obs));
  }

  let corrected = false;
  const seen = new Set<string>();   // executed (tool+args) signatures — guards against re-calling the same read.
  let dupNudges = 0;
  const toolCalls: Record<string, number> = {};
  // Packet 6.2: clamp, never extend, the per-call step cap. Ordinary callers
  // never set maxSteps, so stepCap === MAX_STEPS for every call today.
  const stepCap = input.maxSteps && input.maxSteps > 0 ? Math.min(input.maxSteps, MAX_STEPS) : MAX_STEPS;
  for (let i = 0; i < stepCap; i++) {
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
      const draft = String(parsed.message || '').trim() || 'Done.';
      const message = AGENT_COMPOSE
        ? await composeAnswer({
            accountId, userMessage: input.message, draft, transcript: messages,
            agentContext: input.agentContext, personaBlock,
          })
        : draft;
      steps.push({ thought: narrationFor(parsed) });
      const tokenEstimate = estimateTokens(messages);
      return { status: 'done', message, transcript: messages, steps, tokenEstimate, compaction: compactionLevel(tokenEstimate) };
    }

    // action === 'tool'
    const tool = String(parsed.tool || '');
    const args = (parsed.args && typeof parsed.args === 'object') ? parsed.args : {};
    const def = TOOLS[tool];

    if (!def) {
      steps.push({ thought: narrationFor(parsed), tool });
      messages.push(observation(`ERROR: unknown tool "${tool}".`));
      continue;
    }

    if (def.sensitive) {
      const proposal: AgentProposal = { tool, title: def.title, args, summary: summarizeProposal(tool, args) };
      // Additive: persist the proposal so it survives a closed tab and gets an
      // actor trail (migration 028_approvals.sql). Best-effort — a failure
      // here (e.g. DB unavailable) must never block the existing
      // needs_approval/resume flow, so approvalId is simply omitted.
      // REQUIRED, not best-effort (Packet 0.1): execution is gated on this row,
      // so a proposal we cannot persist can never be approved. Offering it would
      // strand the user on a button that always fails — refuse up front instead.
      try {
        const row = await createApproval(accountId, {
          tool, title: def.title, summary: proposal.summary, args,
          conversationId: input.conversationId ?? null,
          requestedBy: input.requestedBy ?? null,
        });
        proposal.approvalId = row.id;
      } catch {
        return { status: 'error', message: "I couldn't record that action for your approval, so I haven't run it. Please try again.", transcript: messages, steps };
      }
      steps.push({ thought: narrationFor(parsed), tool, args });
      return { status: 'needs_approval', message: proposal.summary, proposal, transcript: messages, steps };
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

    const res = await runTool(tool, accountId, args);
    const obs = observationFor(tool, args, res);
    steps.push({ thought: narrationFor(parsed), tool, args, observation: truncate(obs) });
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
  // Progressive preview of the compose pass, emitted token-by-token while the
  // answer is being written. Carries NO transcript and is NOT authoritative:
  // the `final` event's `message` is the truth and overwrites whatever the
  // client accumulated from these (a mid-stream compose failure falls back to
  // the route pass's draft, which will not match the deltas already sent).
  | { type: 'final_delta'; text: string }
  | { type: 'final'; message: string; transcript: ChatMessage[]; tokenEstimate?: number }
  | { type: 'needs_approval'; proposal: AgentProposal; message: string; transcript: ChatMessage[] }
  | { type: 'compaction_suggested'; level: 'soft' | 'hard'; tokenEstimate: number }
  | { type: 'error'; message: string };

// LOOP-CONTROL INVARIANT (Packet 1.3): runAgentStream and runAgent must keep
// IDENTICAL loop control — the step cap (MAX_STEPS), the executed-signature
// duplicate check and its two-nudge budget, and the per-tool repeat cap of 2.
// Change any of those in one variant and change it in the other in the same
// commit; otherwise the same conversation behaves differently over SSE than
// over the JSON route.
//
// This is NOT a claim that the two are behaviourally identical, and they must
// not be made so. The divergence below is deliberate (Packets 8.1/8.2): this
// variant owns an `emit` channel, streams `final_delta`, and passes an onDelta
// callback to composeAnswer that runAgent intentionally does not. Do not
// "harmonize" the streaming/compose paths.
export async function runAgentStream(input: RunAgentInput, emit: (e: AgentEvent) => void): Promise<void> {
  const { accountId, brandContext } = input;
  // Packet 6.2 — same fan-out gate as runAgent above; see the comment there.
  if (!input.approve && !input.personaId) {
    const fanout = await resolveCoordinatorFanout(accountId, input.personaMentions);
    if (fanout) { await runCoordinatorFanoutStream(accountId, fanout, input, emit); return; }
  }
  const { systemBlock: personaBlock, modelId: personaModelId } = await resolvePersonaForTurn(accountId, input.personaId, input.personaMentions);
  const enabledSkills = await loadEnabledSkillsForAgent(accountId);
  const system = systemPrompt(brandContext?.name, input.agentContext, input.carryover, personaBlock, skillsBlock(enabledSkills));
  const messages: ChatMessage[] = capTranscript(input.transcript || []);

  if (input.message) messages.push({ role: 'user', content: input.message });

  if (input.approve) {
    const { approvalId, tool, args } = input.approve;
    if (!TOOLS[tool]?.sensitive) { emit({ type: 'error', message: 'That action can no longer be approved.' }); return; }
    // HARD GATE (Packet 0.1) — see the matching comment in runAgent.
    try {
      await consumeApprovalForExecution(accountId, approvalId, tool, args);
    } catch (e: any) {
      emit({ type: 'error', message: approvalRefusal(e) });
      return;
    }
    emit({ type: 'tool', tool, title: TOOLS[tool].title, args });
    const res = await runTool(tool, accountId, args);
    const obs = observationFor(tool, args, res);
    emit({ type: 'observation', text: truncate(obs), ok: res.ok, tool, metrics: res.ok ? (capabilityFor(tool)?.metrics?.(args, res.result) ?? {}) : {} });
    messages.push(observation(obs));
  }

  let corrected = false;
  const seen = new Set<string>();
  let dupNudges = 0;
  const toolCalls: Record<string, number> = {};
  // Packet 6.2 — identical clamp to runAgent's, per the LOOP-CONTROL INVARIANT
  // above: both variants must derive the same step cap from the same field.
  const stepCap = input.maxSteps && input.maxSteps > 0 ? Math.min(input.maxSteps, MAX_STEPS) : MAX_STEPS;
  for (let i = 0; i < stepCap; i++) {
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

    // Packet 10.2 Part B: `narration` when the model supplied one, else
    // `thought` exactly as before. `parsed.plan` is never read here — it stays
    // in the transcript for the model and never reaches an SSE payload.
    const narration = narrationFor(parsed);
    if (narration) emit({ type: 'thought', text: String(narration) });

    if (parsed.action === 'final') {
      const draft = String(parsed.message || '').trim() || 'Done.';
      let message = draft;
      if (AGENT_COMPOSE) {
        emit({ type: 'thought', text: 'Writing up the answer…' });
        message = await composeAnswer(
          {
            accountId, userMessage: input.message, draft, transcript: messages,
            agentContext: input.agentContext, personaBlock,
          },
          // Stream the answer to the UI as it is written. The `final` event
          // below still carries the complete, authoritative message.
          (chunk) => emit({ type: 'final_delta', text: chunk }),
        );
      }
      const tokenEstimate = estimateTokens(messages);
      emit({ type: 'final', message, transcript: messages, tokenEstimate });
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
      // REQUIRED, not best-effort — see the matching comment in runAgent.
      try {
        const row = await createApproval(accountId, {
          tool, title: def.title, summary: proposal.summary, args,
          conversationId: input.conversationId ?? null,
          requestedBy: input.requestedBy ?? null,
        });
        proposal.approvalId = row.id;
      } catch {
        emit({ type: 'error', message: "I couldn't record that action for your approval, so I haven't run it. Please try again." });
        return;
      }
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
    const obs = observationFor(tool, args, res);
    emit({ type: 'observation', text: truncate(obs), ok: res.ok, tool, metrics: res.ok ? (capabilityFor(tool)?.metrics?.(args, res.result) ?? {}) : {} });
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

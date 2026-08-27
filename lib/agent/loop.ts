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

import { BUDGET } from '@/lib/ai/context-budget';
import { generateChat, textConfigured, type ChatMessage } from '@/lib/ai/router';
import {
  TOOLS, runTool, toolCatalogForPrompt, toolCatalogStaged, AGENT_STAGED_CATALOG, capabilityFor,
  toolsFromCapabilities, type AgentTool,
} from './tools';
import { loadExternalCapabilities } from '@/lib/capabilities/external-mcp';
import type { Capability, Analysis, Basis } from '@/lib/capabilities/types';
import { estimateTokens, carryoverBlock, type CarryoverMemo } from './memory';
import {
  loadPersonaForAgent, resolveMentionedPersonas, getCoordinator, selectPersonasForRequest,
  buildPersonaSystemBlock, buildCoordinatorSystemBlock, type PersonaRow,
} from './personas';
import { loadEnabledSkillsForAgent } from '@/lib/skills/store';
import { composeAnswer } from './compose';
import { stripAiMarkers } from '@/lib/ai/humanizer';
import { createApproval, consumeApprovalForExecution, markApprovedByToolAndArgs, recordExecutedApproval, ApprovalExecutionError } from '@/lib/approvals/store';
import { consumeGrant, isGrantable } from '@/lib/approvals/grants';
import { markParseOutcome } from '@/lib/credits';
import { log } from '@/lib/logger';
import { buildCachedPrompt } from './prompt-cache';
import { extractJson } from './json-envelope';
import { beginDelegationScope, endDelegationScope, setDelegationContext } from '@/lib/capabilities/delegation';
import { hermesRoute } from '@/lib/ai/hermes';
import { parseBatch, runBatch, batchSummary, MAX_BATCH, type BatchItemResult } from './batch';

// A multi-part request ("research these five agencies, then tailor outreach")
// needs a list call, a web search per company, and then the answer — 10 steps
// could not fit that even before five of them were being lost to guessed tool
// names. Raised now that those two leaks are closed.
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS) || 16;
// Two-pass output (Packet 8.1). The route pass below stays at temp 0.2 / 700
// tokens behind a JSON envelope — correct for tool selection, poor for prose.
// A second compose pass writes what the user actually reads. Set AGENT_COMPOSE=0
// to revert to shipping the route pass's draft verbatim.
const AGENT_COMPOSE = process.env.AGENT_COMPOSE !== '0';
// Per-observation ceiling on what enters the transcript.
//
// Was 2000, which was too small for the job: the SMALLEST realistic marketing
// strategy serialises to ~2,350 chars, so analyzeBrand was truncated on every
// single run — and truncation cuts from the END, taking `unknowns` with it, the
// one section that exists to stop the model inventing facts.
//
// A tool result is evidence the model reasons over. Starving it produces
// confident answers built on a fragment, which is worse than a slow answer
// built on the whole thing. Raised 4x, and bounded by the compose block cap
// (OBSERVATION_BLOCK_CHARS) which is what ultimately reaches the final answer.
export const OBSERVATION_CHAR_LIMIT =
  Number(process.env.AGENT_OBSERVATION_CHARS) || BUDGET.observationChars;

// Long-chat handoff thresholds (token estimate over the running transcript).
// Soft → nudge the user to start a fresh chat (context carried over). Hard →
// the chat is large enough that quality degrades; tell them to switch now.
// Sized to the model that actually answers, not to the weakest tier.
//
// 24k/40k were set when the loop assumed a small fast model. The primary tier is
// Zo Ask, which is a Claude model with a 200k context — so a chat was being told
// to start over at roughly a fifth of what the model could hold, and the
// transcript cap below (2x hard) was throwing away the earliest turns of a
// conversation the model could have read in full. That truncation is felt
// exactly as "it doesn't remember what we were doing".
//
// The headroom left under 200k is deliberate: the system prompt, the tool
// catalog and the grounding block all sit outside this estimate.
export const SOFT_TOKEN_LIMIT = Number(process.env.AGENT_SOFT_TOKENS) || BUDGET.softTokens;
export const HARD_TOKEN_LIMIT = Number(process.env.AGENT_HARD_TOKENS) || BUDGET.hardTokens;

export function compactionLevel(tokenEstimate: number): 'soft' | 'hard' | null {
  if (tokenEstimate >= HARD_TOKEN_LIMIT) return 'hard';
  if (tokenEstimate >= SOFT_TOKEN_LIMIT) return 'soft';
  return null;
}

// The loop is latency-sensitive (a step per model round-trip), so it prefers a
// fast tier; when AGENT_ZOASK_MODEL is unset the Zo Ask call omits model_name
// and uses the account default (Sonnet, sub-billed, no spend gate). If that
// tier errors, the router falls through to DeepSeek-Flash, then NIM. Override
// via AGENT_ZOASK_MODEL. JSON tool-routing is well within a fast model's ability.
const AGENT_ZOASK_MODEL = process.env.AGENT_ZOASK_MODEL || '';
const AGENT_OPENCODE_MODEL = 'deepseek-v4-flash';

// WHICH TIER DOES THE THINKING.
//
// This was the wrong way round. The COMPOSE pass — which only rewrites a draft
// that has already been decided — asked for the heavy tier, so the account's
// Claude subscription wrote the prose. The ROUTE pass — which decides what to
// do, which tools to call, how to break a request apart, and whether the answer
// is even complete — passed no preference at all and took whatever the
// operator's latency-ordered ladder handed it, which is usually the fastest
// tier. All the reasoning that matters was happening on the cheap model and the
// good model was being spent on wording.
//
// 'heavy' puts Zo Ask (Claude) first for the routing pass too. The ladder is
// unchanged underneath: if that tier errors or times out, the call still falls
// through to OpenCode, NIM and the rest exactly as before, so this trades
// latency for quality without adding a way for the turn to fail.
//
// Set AGENT_ROUTE_TIER=fast to put it back on the speed-ordered ladder.
const AGENT_ROUTE_TIER =
  (process.env.AGENT_ROUTE_TIER as 'fast' | 'balanced' | 'heavy' | undefined) || 'heavy';

// Ceiling, not a budget: resolveMaxOutputTokens takes min(model capability,
// this), and the Zo Ask tier ignores it entirely (it has no output parameter —
// the model's own limit applies). Replaces a hardcoded maxOutputTokens of 2048,
// which capped a step's reasoning at a number picked for a small model. A route
// step is normally a few hundred tokens; this only stops a long plan from being
// guillotined mid-JSON, which is one of the ways the turn used to die.
const AGENT_ROUTE_CEILING = Number(process.env.AGENT_ROUTE_CEILING) || 16_000;

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
  /** The brand the operator has selected in the UI.
   *
   *  Carried alongside the NAME because the name is only good for the prompt —
   *  scoping a query needs the id. Its absence is why every brand-scoped tool
   *  call ran across the whole account: the loop simply had no id to pass. */
  brandContext?: { name?: string; id?: string };
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
  /** Marks this run as a delegate sub-run (lib/capabilities/delegation.ts).
   *  A delegate may not delegate further and may not raise approvals — see the
   *  bounds documented there. Absent for every ordinary caller. */
  isDelegate?: boolean;
  /** Skill slugs pinned by a plan (migration 066). When present these REPLACE
   *  per-turn routing: a plan worked one step per tick would otherwise get
   *  different guidance on each step, because selectSkillsForTurn routes
   *  against the message and every step is a different message. */
  pinnedSkills?: string[];
  /** Plan mode: the turn writes a plan and stops, instead of executing it.
   *  Set by the caller (a UI toggle), never by the model — the model must not
   *  be able to decide it is allowed to skip the operator's go-ahead. */
  planOnly?: boolean;
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
function skillsBlock(skills: { name: string; instructions: string; capabilities?: string[] }[]): string {
  if (!skills.length) return '';
  return [
    'ENABLED SKILLS — apply this guidance when relevant to the current task:',
    ...skills.map((s) => {
      // A skill may name the capabilities its guidance is about (migration
      // 051). This is the bridge from prose to action: previously a skill
      // could describe a competitor teardown but had no way to say the work
      // needs a web search, so the model had to infer it. Naming them is NOT a
      // grant — every one is the same tool, behind the same approval gate,
      // that the assistant could already call. Names are filtered against the
      // live registry so a stale one is ignored rather than sending the model
      // after a tool that does not exist.
      const tools = (s.capabilities || []).filter((c) => Boolean(TOOLS[c]));
      const uses = tools.length ? ` [this work uses: ${tools.join(', ')}]` : '';
      return `• ${s.name}${uses}: ${s.instructions}`;
    }),
  ].join('\n');
}

// Above how many enabled skills it stops being safe to inject them all. The
// catalog is 353 skills (12 curated + 341 harvested); an account that enables
// even a fraction would blow the context window and bury the relevant guidance
// in noise. Below this we skip routing entirely — a small set costs less to
// include than an extra classify round-trip costs in latency.
const SKILL_ROUTING_THRESHOLD = 8;
// Hard ceiling on what routing may return, matching Hermes's own "pick 1-4"
// instruction. Belt and braces: a malformed plan cannot flood the prompt.
const MAX_ROUTED_SKILLS = 4;

/**
 * Choose which of an account's enabled skills belong in THIS turn's prompt.
 *
 * Packet: closes the gap where the loop injected every enabled skill regardless
 * of the request. Hermes (lib/ai/hermes.ts) already solves selection — it
 * shortlists the catalog, asks a cheap classify call for 1-4 ids, and falls back
 * to deterministic keyword rules when the model is unavailable — but nothing in
 * the agent path called it. This is that call.
 *
 * Failure is never fatal: any error, empty plan, or non-overlapping result falls
 * back to a truncated slice of the enabled set, so the assistant degrades to
 * "some guidance" rather than losing skills entirely.
 */
async function selectSkillsForTurn(
  enabled: { slug: string; name: string; instructions: string }[],
  message: string | undefined,
  ventureName: string | undefined,
): Promise<{ name: string; instructions: string }[]> {
  if (enabled.length <= SKILL_ROUTING_THRESHOLD) return enabled;
  const text = (message || '').trim();
  if (!text) return enabled.slice(0, MAX_ROUTED_SKILLS);

  try {
    const plan = await hermesRoute(text, ventureName ? { ventureName } : {});
    const wanted = new Set(plan.skillIds || []);
    // Intersect: Hermes routes over the whole catalog, but an account may not
    // have every routed skill enabled. Enabled-ness always wins.
    const picked = enabled.filter((s) => wanted.has(s.slug)).slice(0, MAX_ROUTED_SKILLS);
    return picked.length ? picked : enabled.slice(0, MAX_ROUTED_SKILLS);
  } catch {
    return enabled.slice(0, MAX_ROUTED_SKILLS);
  }
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
// `externalTools` (Packet 4) folds an account's connected-MCP-client tools
// into the catalog for THIS turn. Optional and additive: every call site that
// predates Packet 4 omits it, so the prompt is byte-identical to before.
/** Cache key for the static half — see lib/agent/prompt-cache.ts. Everything
 *  that can change the STATIC sections must appear here, and nothing volatile
 *  may: an account id plus its persona and the size of its tool set identifies
 *  the shape, and the content hash inside the cache is what actually decides a
 *  hit, so a coarse key costs a rebuild and can never serve wrong text. */
function promptCacheKey(accountId: string | undefined, personaBlock?: string, externalTools?: Record<string, AgentTool>): string {
  return [accountId || 'anon', personaBlock ? 'p' : '-', String(Object.keys(externalTools || {}).length)].join(':');
}

function systemPrompt(brandName?: string, agentContext?: string, carryover?: CarryoverMemo | null, personaBlock?: string, skillsGuidance?: string, externalTools?: Record<string, AgentTool>, accountId?: string, planOnly?: boolean): string {
  const staticSections: string[] = [
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
    `  {"thought":"<short plain-language sentence>","action":"tool","tool":"<toolName>","calls":[{...args},{...args}]}   <- run the SAME tool over many inputs AT ONCE`,
    '  {"thought":"<short plain-language sentence>","action":"final","message":"<your full reply to the user>"}',
    'The "thought" is shown to the user live as your thinking step — write it as a human sentence ("Checking your active campaigns…"), never a raw tool name.',
    'You MAY split that one field into two, in either shape — both are optional and either may be omitted:',
    '  "plan": your own internal reasoning about what to do next. It is NEVER shown to the user, so be as technical as you like.',
    '  "narration": the single line the user reads instead of "thought". Short, plain language, present tense, no tool, vendor, or model names ("Pulling this month\'s numbers…").',
    'When "narration" is present it replaces "thought" in the live trace. When it is absent, "thought" is used exactly as described above — so omitting both new fields is always safe.',
    '',
    `WHEN YOU HAVE MANY OF THE SAME THING TO DO, USE "calls" — do NOT do them one per step. Revealing twenty leads is ONE decision applied to twenty rows, not twenty decisions: put all twenty argument sets in "calls" and they run together in a single step. Doing them one at a time runs out of steps long before the work is finished, so a list handled one-per-step is a job that never completes. Use "args" only for a genuinely single action. Never send both. At most ${MAX_BATCH} per batch — if you have more, do ${MAX_BATCH} in one step and the rest in the next.`,
    'A batch of an action that needs approval is ONE approval covering the whole batch, so the user sees a single card naming every item rather than being asked the same question twenty times.',
    '',
    'HOW YOU WORK:',
    '- Ground every answer in this account\'s real data — use the context above and the tools; never invent numbers, leads, or campaigns.',
    // Reporting a result that no tool produced is the single worst failure this
    // assistant has: asked to pull and enrich two leads, it answered with two
    // invented contacts at a real company, complete with a founding year and a
    // headcount, none of which came from any observation. Stated as bald a rule
    // as the protocol allows, because the compose pass downstream will faithfully
    // polish a fabricated draft into something that reads true.
    '- A result exists only if a tool returned it. Never state a name, email, count, or outcome you did not read in an OBSERVATION line, and never describe what a [needs approval] action found — it has not run yet. If a tool failed, returned nothing, or returned masked/placeholder values, say exactly that.',
    '- Answer the question that was asked and stop. Do not append an account roundup, a list of connected accounts, or unrelated suggestions the user did not ask for.',
    '- To DO a task, call the tool for it. Resolve names to ids first with the list tools (listVentures, listAdAccounts, listCampaigns). Chain tools across turns to complete multi-step jobs.',
    // The failure this fixes: "research the leads we have — learn everything on
    // what they do, how they operate, what they have done before" was answered by
    // one listLeads call and a three-line recital of the rows, with no research at
    // all and no filtering to the kind of company that was asked about. Reading a
    // record is not researching it, and the model needs to be told where the line
    // is.
    '- RESEARCH MEANS RESEARCH. When the user asks you to research, look into, learn about, or dig into people or companies, listing what is already in the CRM is NOT an answer. Pull the records, then call webSearch once per company (and again per person when it matters) to find what they do, how they operate, and what they have shipped — then answer from what you found. Say which ones you could not find anything on rather than padding them out.',
    '- Filter to what was actually asked for. If the user asks about agencies and the records include a producer and an investor, say the list does not contain what they are after instead of answering with the wrong rows.',
    '- Multi-part requests get every part addressed. If you run out of steps, finish with what you have and say plainly which parts are still outstanding.',
    '- Reads and safe internal writes run immediately. Tools marked [needs approval] spend money, send to real people, or are destructive — just call them; the platform pauses and asks the user to confirm before anything real happens. Do NOT ask for confirmation yourself in text; the call itself is the ask.',
    '- If a request is genuinely ambiguous in a way that changes the outcome, ask ONE focused clarifying question with action:"final". Otherwise make the reasonable call and proceed.',
    // Read for INTENT, not for literal tokens. People dictate, they typo, they
    // send a file with no sentence. A request that is obvious in context should
    // be acted on, not bounced back — and a request that genuinely is not
    // should be asked about ONCE, with the reading you already have offered.
    '- Read what the user MEANT. Dictation and typing produce wrong words, missing words and homophones ("film on Apollo" for "find on Apollo", "sequence" for "sequences"). When the surrounding sentence makes the intent obvious, act on the intent and do not comment on the mistake. Only ask when the misreading would change what you actually do.',
    '- A file with no instruction is still a request. If the user attaches something and says little or nothing, read it, say what it is and what is in it, then either propose the obvious next step or ask what they want — do not stop at "what would you like me to do with this?" without first showing you have read it.',
    '- Use what you already have before asking for it. Their ventures, contacts, saved documents, remembered facts and past decisions are in your context or one tool call away. Ask the user only for things that genuinely are not on the platform.',
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
          toolCatalogStaged(externalTools),
        ]
      : [
          'AVAILABLE TOOLS:',
          toolCatalogForPrompt(externalTools),
        ]),
  ];

  // ---- VOLATILE (changes per turn — nothing static may follow) --------------
  // Both blocks below are per-turn grounding. They are LAST on purpose; see
  // the PROMPT BLOCK ORDER note above before moving either of them. Keeping
  // them out of the cached half is what makes the static prefix byte-stable
  // across a turn's sixteen steps, which is the whole point.
  const dynamicSections: string[] = [
    '',
    // Volatile on purpose: this changes per turn, and a cached static prefix
    // would carry one turn's mode into the next.
    planOnly
      ? [
          'PLAN MODE IS ON FOR THIS TURN. Do NOT do the work.',
          'Call createPlan with an objective and ordered steps, then answer with action:"final" describing the plan in plain language and asking whether to go ahead or change it.',
          'Read-only tools are fine if you genuinely need them to write a sensible plan. Do not call anything that writes, sends, spends or changes state — not even something the user seems to have already asked for.',
        ].join('\n')
      : '',
    agentContext || (brandName ? `The user is working in the "${brandName}" venture; prefer it when a venture is needed and not otherwise specified.` : ''),
    carryover ? '\n' + carryoverBlock(carryover) : '',
  ];

  return buildCachedPrompt(
    promptCacheKey(accountId, personaBlock, externalTools),
    { sections: staticSections.filter(Boolean) },
    { sections: dynamicSections.filter(Boolean) },
  ).prompt;
}

function summarizeProposal(tool: string, args: Record<string, any>, extraCaps?: Record<string, Capability>, extraTools?: Record<string, AgentTool>): string {
  // A capability may supply its own summary (Packet 2.1). None do today, so
  // every existing branch below still fires and output is unchanged; later
  // packets add `summarize` so this branch list stops growing.
  const cap = capabilityFor(tool, extraCaps);
  if (cap?.summarize) return cap.summarize(args);
  const t = TOOLS[tool] ?? extraTools?.[tool];
  const title = t?.title || tool;
  // External MCP tools (Packet 4) have no bespoke branch below — a third
  // party's action can't be summarized from a known verb the way
  // launchCampaign/sendEmail/etc. can. Say plainly that it reaches outside
  // LeadRail so the approval card doesn't understate what's being confirmed.
  if (cap?.domain === 'external') return `Run "${title}" on a connected external tool with these details: ${JSON.stringify(args)}.`;
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

// The JSON-envelope parser lives in ./json-envelope — a pure function with no
// dependencies, so it can be tested directly against the real model responses
// that broke it rather than through the whole agent loop.


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
// Recover a human answer from a model response that is prose, or a JSON whose
// "message" got truncated mid-string. From main: the streaming loop calls this
// before giving up, so a cut-off final turns into the partial answer rather
// than a generic failure. Kept in the merge because the branch's correction
// nudge costs an extra round-trip and still fails on hard truncation.
function salvageFinalMessage(raw: string): string | null {
  const m = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (m && m[1]) {
    try { return JSON.parse('"' + m[1].replace(/\\?$/, '') + '"'); }
    catch { return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim(); }
  }
  const stripped = raw.replace(/```json|```/g, '').trim();
  if (stripped && !stripped.startsWith('{')) return stripped;
  return null;
}

/** How many times one turn will re-ask for a valid JSON envelope before it
 *  gives up. Was effectively 1. A single nudge is not enough on the requests
 *  that matter most: the long, multi-part ones ("research these five agencies,
 *  learn how they operate, then tailor outreach") are exactly the ones that
 *  push the route pass into writing prose, and the user saw them all die as
 *  "I couldn't complete that request. Please rephrase and try again." — after
 *  the tools had already run and the evidence was already in hand. */
/**
 * Wall-clock ceiling on one turn.
 *
 * MAX_STEPS bounds how many times a turn may loop; nothing bounded how LONG.
 * Those are different limits, and only one of them was set. Observed in
 * production: turns of 6, 9 and 18 minutes, each burning its step budget on
 * retries while the person who asked sat watching a spinner. Eighteen minutes
 * is not a slow answer, it is an abandoned one.
 *
 * Checked BEFORE each step rather than after, so the deadline caps the wait
 * instead of being noticed once it has already been exceeded. Passing it does
 * not fail the turn: the loop breaks into the forced-final it already has, so
 * the user gets an answer built from whatever was actually gathered. A partial
 * answer now beats a complete one nobody waited for.
 *
 * Sized above the slow-but-real case — the primary tier can legitimately take
 * ~2 minutes on a large prompt, and a turn may take several such steps.
 */
const TURN_DEADLINE_MS = Number(process.env.AGENT_TURN_DEADLINE_MS) || 5 * 60 * 1000;

const MAX_JSON_RETRIES = 2;

/** How much of a contract-breaking reply is echoed back to the model, and kept
 *  in the persisted transcript, before the nudge.
 *
 *  WHY IT IS ECHOED AT ALL. The nudge says "Your last reply was not valid
 *  JSON" — but that reply was never pushed into `messages`. It was dropped at
 *  the `continue` below, so the model was being asked to correct something it
 *  could not see, and the raw text was gone the moment the turn returned. Seven
 *  real failures were recovered from production transcripts by finding these
 *  nudges; not one of them had the offending output attached.
 *
 *  WHY IT IS CAPPED. A runaway response must not be able to push the transcript
 *  past the model's window on the one turn that is already going wrong. */
const RAW_ECHO_CHARS = Number(process.env.AGENT_RAW_ECHO_CHARS) || 2_000;

/** The nudge text for retry n. The second one is deliberately blunter and
 *  narrower than the first: by then the model has already ignored the polite
 *  version, and asking only for the `final` shape gets an answer out of a model
 *  that is mid-prose rather than restarting the routing decision. */
function jsonNudge(attempt: number): string {
  return attempt <= 1
    ? 'Respond with ONLY one JSON object using the "tool" or "final" shape.'
    : 'Your last reply was not valid JSON, so it could not be used. Reply with ONE JSON object and nothing else: {"action":"final","message":"<your answer to the user>"}. No prose outside it, no code fences.';
}

/** The shared retry step for a route pass that broke the JSON contract.
 *
 *  BOTH runAgent and runAgentStream must call this — their handling of the
 *  envelope is required to stay identical, the same rule that already governs
 *  observationFor/narrationFor. It lives here so the two loops cannot drift on
 *  the one path that exists to diagnose them.
 *
 *  Order is load-bearing: the failing reply is pushed as the assistant's own
 *  turn BEFORE the nudge, so "your last reply was not valid JSON" finally has a
 *  referent, and so the text survives the turn — `messages` is what
 *  saveConversation persists.
 */
function pushJsonRetry(
  messages: ChatMessage[],
  raw: string,
  attempt: number,
  ctx: { accountId?: string; step: number; afterTool?: string | null },
): void {
  messages.push({ role: 'assistant', content: truncate(raw, RAW_ECHO_CHARS) });
  // Persisted to app_logs (log.warn, lib/logger.ts). The terminal log.error
  // further down has never fired once across 34k rows, because it sits behind
  // BOTH exhausted retries AND failed salvage — so a failure that a retry
  // rescues was, until now, completely unobservable. This is the line that
  // makes the recoverable ones countable.
  log.warn('agent: model output failed JSON contract', {
    accountId: ctx.accountId,
    step: ctx.step,
    attempt,
    afterTool: ctx.afterTool ?? null,
    rawPreview: raw.slice(0, 500),
  });
  messages.push({ role: 'user', content: jsonNudge(attempt) });
}

/** Last resort before a turn is declared a failure.
 *
 *  A route pass that cannot produce valid JSON has NOT necessarily failed the
 *  user: by the time it breaks, the turn has usually already run its tools, and
 *  their observations are sitting in the transcript. Throwing that away and
 *  showing "I couldn't complete that request" spends the user's time and the
 *  account's credits and returns nothing.
 *
 *  So: if there is at least one observation, hand it to the compose pass, which
 *  is grounded on OBSERVATION lines by construction, and let it write the answer
 *  the route pass could not envelope. Returns null when there is genuinely
 *  nothing to say — a cold failure on step 0 with no tool run — and the caller
 *  falls back to the error it would have shown anyway.
 */
async function answerFromObservations(
  input: RunAgentInput,
  messages: ChatMessage[],
  personaBlock?: string,
): Promise<string | null> {
  const hasEvidence = messages.some(
    (m) => typeof m.content === 'string' && m.content.startsWith('OBSERVATION: '),
  );
  if (!hasEvidence) return null;
  try {
    const composed = await composeAnswer({
      accountId: input.accountId,
      userMessage: input.message,
      draft: 'Answer the user from the observations below. Cover what was actually found, and state plainly which parts of their request are not answered by it.',
      transcript: messages,
      agentContext: input.agentContext,
      personaBlock,
    });
    const trimmed = stripAiMarkers(composed).trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/** The observation left behind when a turn stops for approval.
 *
 *  THIS IS NOT COSMETIC. A sensitive tool call is pushed into the transcript as
 *  an assistant message and the turn then returns — so the persisted
 *  conversation contained a tool call with NO observation after it, which is the
 *  exact shape of "a tool ran and I have its result". On the next turn the model
 *  read its own pending proposal as a completed action and invented the result.
 *
 *  It is not hypothetical. A real transcript: the model proposed sourceLeads,
 *  the turn stopped for approval, the user re-sent their message instead of
 *  approving — and the model's very next step called enrichLead with
 *  "newlead1@agency.com", an address it had made up to stand in for a search
 *  result it never received. Apollo matched the domain, returned a real
 *  organisation, and the user was told two leads had been found. This line is
 *  what makes the gap in the transcript legible instead of invisible.
 */
function pendingApprovalObservation(tool: string): ChatMessage {
  return observation(
    `PENDING APPROVAL — "${tool}" has NOT run. It is waiting for the user to approve it, and it produced NO result. ` +
    'Do not describe, summarise, or invent its output, and do not call another tool with values you would have gotten from it. ' +
    'If the user asks again before approving, tell them it is still waiting on their approval.',
  );
}

/** How many unknown tool names one turn tolerates before it is made to answer.
 *
 *  From a real transcript: asked what it knew about a venture, the model spent
 *  five consecutive steps calling getDeckSummary, getPitch, getSectors, getIcp
 *  and getLeadGoal — none of which exist. Each one was a full model round-trip,
 *  each got back the bare string 'ERROR: unknown tool "X".' with no indication
 *  of what DOES exist, and half the step budget was gone before any real work
 *  started. That is both the latency the user feels and the reason long requests
 *  run out of steps. */
const MAX_UNKNOWN_TOOLS = 2;

/** Turn a wrong tool name into a useful correction.
 *
 *  Cheap edit-distance-free matching: a real name is offered when it shares a
 *  meaningful prefix or substring with what the model reached for, which covers
 *  the observed failure mode (getPitch → getPersona, getIcp → updateIcpProfile).
 *  Falls back to naming the read tools, which is what a model guessing at
 *  getters actually wants. */
function unknownToolObservation(
  tool: string,
  known: string[],
  attempt: number,
): ChatMessage {
  const needle = tool.toLowerCase().replace(/^(get|list|fetch|read)/, '');
  const close = known
    .filter((n) => {
      const l = n.toLowerCase();
      return needle.length >= 3 && (l.includes(needle) || needle.includes(l.replace(/^(get|list)/, '')));
    })
    .slice(0, 6);
  const suggestions = close.length
    ? `Closest real tools: ${close.join(', ')}.`
    : `Real tools include: ${known.filter((n) => /^(get|list)/.test(n)).slice(0, 12).join(', ')}.`;
  const lastChance = attempt >= MAX_UNKNOWN_TOOLS
    ? ' You have used up your guesses at tool names — answer the user now with action:"final", using what you already have and saying plainly what you could not look up.'
    : ' Use a tool name EXACTLY as it appears in AVAILABLE TOOLS above — do not invent one.';
  return observation(`ERROR: there is no tool called "${tool}". ${suggestions}${lastChance}`);
}

function narrationFor(parsed: any): string | undefined {
  const n = parsed?.narration;
  if (typeof n === 'string' && n.trim() !== '') return n;
  return parsed?.thought;
}

function truncate(s: string, limit: number = OBSERVATION_CHAR_LIMIT): string {
  return s.length > limit ? `${s.slice(0, limit)}… [truncated]` : s;
}

function observation(text: string, limit?: number): ChatMessage {
  return { role: 'user', content: `OBSERVATION: ${truncate(text, limit)}` };
}

/** The observation budget for one tool's result. Defaults to the shared cap;
 *  a capability whose RESULT IS THE DELIVERABLE may declare a larger one (see
 *  Capability.observationLimit). Unknown tools get the default. */
function obsLimitFor(tool: string, extraCaps?: Record<string, Capability>): number | undefined {
  return capabilityFor(tool, extraCaps)?.observationLimit;
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
function successObservation(tool: string, args: any, result: any, extraCaps?: Record<string, Capability>): string {
  const raw = JSON.stringify(result);
  let digest = '';
  try {
    digest = (capabilityFor(tool, extraCaps)?.digest?.(args, result) || '').trim();
  } catch {
    digest = '';
  }
  return digest ? `${digest}\n${raw}` : raw;
}

/** The single observation-building path shared by runAgent and runAgentStream.
 *  Both loops MUST call this — they are required to stay identical here.
 *  `extraCaps` (Packet 4) is threaded through so an external tool's result
 *  gets the same treatment as a first-party one (today: none declare a
 *  digest, so this is raw JSON — same as any first-party tool without one). */
function observationFor(tool: string, args: any, res: { ok: boolean; result?: any; error?: string }, extraCaps?: Record<string, Capability>): string {
  return res.ok ? successObservation(tool, args, res.result, extraCaps) : `ERROR: ${res.error}`;
}

/** Best-effort structured analysis for a SUCCESSFUL tool run — see
 *  `Capability.findings` in lib/capabilities/types.ts. Same discipline as
 *  successObservation above: a throwing or absent `findings` degrades to no
 *  analysis events, never fails (or even affects) the tool call itself. Only
 *  the streaming loop calls this today — it exists to feed the live SSE
 *  evidence/claim/finding/verdict events, which the non-streaming path has
 *  no channel to emit. */
function analysisFor(tool: string, args: any, res: { ok: boolean; result?: any }, extraCaps?: Record<string, Capability>): Analysis | null {
  if (!res.ok) return null;
  try {
    return capabilityFor(tool, extraCaps)?.findings?.(args, res.result) ?? null;
  } catch {
    return null;
  }
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
        // NOTE (not a TODO): the full fan-out EXISTS — see runCoordinatorFanout
        // above, which runAgent/runAgentStream check first. This branch is only
        // the fallback for when that path declines. Historical text follows:
        // a full pass would run each mentioned
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
 * Re-raise a proposal whose approval lapsed before it could run.
 *
 * WHY ONLY `expired`. The other refusals must NOT come back:
 *   not_approved     — the person said no, or never said yes. Re-proposing is
 *                      nagging past a decision.
 *   already_executed — it ran. Re-proposing is a second spend.
 *   args_mismatch    — the details moved between approval and execution, which
 *                      is a signal something is wrong, not a timing accident.
 *
 * An expiry is the one case where nothing was decided and nothing happened: the
 * clock simply ran out. The agent is still holding the exact tool and args, so
 * ending the turn and telling the person to type "propose again" throws away
 * everything it already knows and makes them redo a turn to reach the identical
 * card. This raises that card directly.
 *
 * It is NOT a bypass. The new approval is a fresh row with a fresh clock, and a
 * person still has to click it. Nothing executes on the strength of a lapsed
 * approval — which is the property the expiry existed to protect.
 */
async function reproposeAfterExpiry(
  accountId: string,
  tool: string,
  args: Record<string, any>,
  def: { title: string },
  opts: {
    conversationId?: string;
    requestedBy?: string;
    extraCapsByName?: Record<string, Capability>;
    extraTools?: Record<string, AgentTool>;
  },
): Promise<AgentProposal | null> {
  try {
    const proposal: AgentProposal = {
      tool, title: def.title, args,
      summary: summarizeProposal(tool, args, opts.extraCapsByName, opts.extraTools),
    };
    const row = await createApproval(accountId, {
      tool, title: def.title, summary: proposal.summary, args,
      conversationId: opts.conversationId ?? null,
      requestedBy: opts.requestedBy ?? null,
      gate: capabilityFor(tool, opts.extraCapsByName)?.gate,
    });
    proposal.approvalId = row.id;
    return proposal;
  } catch {
    // Could not persist the new proposal. Fall back to the plain refusal —
    // offering a card that can never be approved is worse than saying so.
    return null;
  }
}


/** Human summary for a batch approval card. Names every item, because the whole
 *  point of one card for many actions is that the person can see what all of
 *  them are — a card reading "reveal 25 people" with no names is a worse gate
 *  than twenty-five separate cards, not a better one. */
function summarizeBatchProposal(
  tool: string,
  calls: { args: Record<string, any> }[],
  extraCaps?: Record<string, Capability>,
  extraTools?: Record<string, AgentTool>,
): string {
  const lines = calls.map((c, i) => `${i + 1}. ${summarizeProposal(tool, c.args, extraCaps, extraTools)}`);
  return `${calls.length} actions, all of them ${tool}:\n${lines.join('\n')}`;
}

/** Fold a batch's results into one observation. Every item is reported,
 *  successes and failures alike: the model has to be able to tell WHICH of the
 *  twenty-five did not work, or its next step is a guess. */
function batchObservation(tool: string, results: BatchItemResult[], extraCaps?: Record<string, Capability>): string {
  const lines = results.map((r) =>
    r.ok
      ? `[${r.index + 1}] ok — ${observationFor(tool, r.args, { ok: true, result: r.result }, extraCaps)}`
      : `[${r.index + 1}] FAILED — ${r.error || 'no reason given'}`,
  );
  return `${batchSummary(tool, results)}\n${lines.join('\n')}`;
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
    case 'expired':          return 'That approval lapsed before I could carry it out, so I did not run it. Ask me to propose it again.';
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
  input_message?: string,
): Promise<{ coordinator: PersonaRow; delegates: PersonaRow[] } | null> {
  try {
    // Explicit @mentions still win — if someone names the team, honour it.
    // Otherwise the ASSISTANT picks, because the user has no reason to know
    // which personas exist. Requiring "@Ada @Nia" meant the whole fan-out was
    // unreachable for anyone who had not read the persona list.
    let matched = personaMentions?.length
      ? await resolveMentionedPersonas(accountId, personaMentions)
      : [];
    if (matched.length < 2) {
      const auto = await selectPersonasForRequest(accountId, input_message || '', MAX_FANOUT_DELEGATES);
      // One match is a specialist question, not a team question — let the normal
      // single-agent path handle it rather than convening a fan-out of one.
      if (auto.length >= 2) matched = auto;
    }
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
/** What a persona is doing, phrased for the person watching. Derived from the
 *  ROLE rather than hardcoded per persona, so a new persona narrates correctly
 *  the moment it is created. */
function personaVerb(persona: PersonaRow): string {
  const role = `${persona.role || ''}`.toLowerCase();
  if (/analyst/.test(role)) return 'checking the numbers';
  if (/media|buyer/.test(role)) return 'reviewing spend and channels';
  if (/copywriter/.test(role)) return 'working on the messaging';
  if (/creative director|director of creative/.test(role)) return 'reviewing the work';
  if (/strategist/.test(role)) return 'thinking about positioning';
  if (/lifecycle/.test(role)) return 'mapping the sequence';
  if (/social/.test(role)) return 'looking at social';
  if (/account/.test(role)) return 'checking scope and goals';
  return 'looking into it';
}

async function runFanoutDelegates(
  accountId: string,
  personas: PersonaRow[],
  input: RunAgentInput,
  // Optional so the non-streaming runAgent path is unaffected. When present,
  // each delegate announces itself BEFORE it runs — previously every
  // "Consulting X…" line was emitted upfront and the UI then went silent for the
  // whole fan-out, which is the longest operation in the system.
  emit?: (e: AgentEvent) => void,
): Promise<{ outcomes: DelegateOutcome[]; needsApproval?: AgentResult }> {
  const delegates = personas.slice(0, MAX_FANOUT_DELEGATES); // constraint (2)

  // CONCURRENT, not sequential — this was the single biggest source of latency
  // in the product.
  //
  // Each delegate is a FULL agent turn: its own loop, its own model calls, its
  // own DB reads. Running three of them one after another meant a fan-out cost
  // the SUM of three complete turns before the coordinator had even started
  // composing, which is how a single request reached four minutes. They are
  // independent by construction — the comment above says so: each reasons from
  // the same starting request and never sees the others' tool calls — so the
  // sequencing bought nothing except waiting.
  //
  // Wall-clock is now the SLOWEST delegate rather than the sum of all of them.
  //
  // WHAT THE OLD ORDERING GAVE UP, and why it is affordable: the shared step
  // budget could be spent adaptively, a later delegate getting whatever an
  // earlier one left. Concurrently there is no "later", so each is given an
  // equal slice of the same ceiling. The total is identical; only the
  // distribution is fixed in advance.
  const perDelegate = Math.max(1, Math.min(
    MAX_FANOUT_STEPS_PER_DELEGATE,
    Math.floor(MAX_FANOUT_TOTAL_STEPS / Math.max(1, delegates.length)),
  ));

  // Announced up front because they genuinely all start now. The previous
  // version announced each one as it began, which was honest when they ran in
  // sequence and would be a lie here.
  for (const persona of delegates) {
    emit?.({ type: 'step_start', text: `${persona.name} is ${personaVerb(persona)}…`, parallel: true, key: `delegate:${persona.id}` });
  }

  // Progress is reported AS EACH DELEGATE SETTLES, not once they all have.
  // Folding still happens in delegate order below — the synthesis input stays
  // reproducible — but the trace no longer goes silent for the length of the
  // slowest delegate while the other two have already finished. That silence is
  // what made a fan-out indistinguishable from a hang.
  const announce = (persona: PersonaRow, result: { status: string; message: string }) => {
    if (result.status === 'needs_approval') return;
    emit?.({
      type: 'observation',
      key: `delegate:${persona.id}`,
      ok: result.status !== 'error',
      text: result.status === 'error'
        ? `${persona.name} hit a problem: ${truncate(result.message)}`
        : `${persona.name}: ${truncate(result.message)}`,
    });
  };

  const settled = await Promise.all(delegates.map(async (persona) => {
    try {
      const result = await runAgent({
        accountId,                 // constraint (4) — never a different account
        message: input.message,
        agentContext: input.agentContext,
        personaId: persona.id,
        maxSteps: perDelegate,
        requestedBy: input.requestedBy,
        conversationId: input.conversationId,
        // Deliberately no `transcript`/`carryover`/`approve` here: a delegate
        // is a fresh, self-contained sub-turn, not a resume of the
        // coordinator's own conversation.
      });
      announce(persona, result);
      return { persona, result };
    } catch (e: any) {
      // One delegate throwing must not take the fan-out with it. Before, a
      // rejection propagated out of the loop and the whole turn died with
      // whatever the others had already produced thrown away.
      const result = {
        status: 'error' as const,
        message: String(e?.message || e).slice(0, 300),
        steps: [] as AgentStep[],
      };
      // Announced here too: a delegate that FAILED must close its own line. If
      // only the success path reported, a thrown delegate would spin forever in
      // the trace while the fan-out had already moved on without it.
      announce(persona, result);
      return { persona, result };
    }
  }));

  const outcomes: DelegateOutcome[] = [];

  // Results are folded in DELEGATE ORDER, not completion order, so the same
  // request produces the same synthesis input every time. A fan-out whose
  // observations arrive in whatever order the network settled would make the
  // coordinator's answer irreproducible for no benefit.
  for (const { persona, result } of settled) {
    if (result.status === 'needs_approval') {
      // Constraint (1) still holds: an approval stops the fan-out. Concurrently
      // the others have already run, so this returns what completed alongside
      // it rather than pretending they did not.
      return { outcomes, needsApproval: result as AgentResult };
    }
    // Already announced by `announce` as this delegate settled — emitting here
    // too would double every line in the trace.
    outcomes.push({
      persona,
      status: result.status,
      message: result.message,
      stepsUsed: result.steps.length,
    });
  }
  return { outcomes };
}

/** Phrases that mark a synthesis which has abstracted away the substance it
 *  was given. Each one is a construction that can be written without having
 *  read the delegates at all — which is precisely the failure being caught. */
const VAGUE_SYNTHESIS_PHRASES = [
  'several factors',
  'it depends on your',
  'there are many ways',
  'a variety of approaches',
  'each has its own merits',
  'the team has provided',
  'based on the analysis above',
  'in conclusion, it is important',
  'further analysis is needed',
  'more information is required',
  'consider all the options',
];

/** Returns the phrases a synthesis tripped, empty when it is specific enough. */
function validateSynthesis(text: string): string[] {
  const lower = text.toLowerCase();
  const hits = VAGUE_SYNTHESIS_PHRASES.filter((p) => lower.includes(p));
  // A synthesis shorter than the shortest delegate answer has almost certainly
  // compressed rather than reconciled. Length is a weak signal on its own, so
  // it only counts alongside at least one phrase hit.
  return hits;
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
        content: `User's request: ${userMessage || '(none)'}\n\nDelegate responses:\n${block}\n\nWrite the single unified final answer for the user now. Plain language, no JSON, no markdown headers. Every claim must be traceable to a delegate response above — do not summarise them into vagueness.`,
      }],
      temperature: 0.3,
      // Was a hard 800 tokens — enough to truncate a synthesis of three
      // delegates mid-sentence. Follows the selected model's own ceiling now.
      maxOutputCeiling: AGENT_ROUTE_CEILING,
      preferTier: AGENT_ROUTE_TIER,
      zoAskModel: AGENT_ZOASK_MODEL,
      model: AGENT_OPENCODE_MODEL,
      ...(coordinator.model_id ? { accountId, modelId: coordinator.model_id } : {}),
    });
    const trimmed = raw.trim();
    if (!trimmed) return block;

    // OUTPUT VALIDATION. A synthesis pass has a specific failure mode: given
    // three specialists' findings it produces something that reads well and
    // says nothing — "several factors are at play", "it depends on your
    // goals" — because generic hedging is the safest text that fits every
    // input. That output is worse than the raw delegate answers it replaced,
    // and it is invisible: it looks like a good answer.
    //
    // So the result is checked for the phrases that mark it, and a synthesis
    // that trips the check is DISCARDED in favour of the delegates' actual
    // words. Falling back to slightly rough attributed text beats shipping
    // fluent emptiness.
    const violations = validateSynthesis(trimmed);
    if (violations.length) {
      log.warn('coordinator synthesis rejected as vague', {
        accountId, coordinator: coordinator.name, violations, preview: trimmed.slice(0, 200),
      });
      return block;
    }
    return trimmed;
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

  // Name the team ONCE, then let each delegate narrate itself as it runs. The
  // previous version emitted every "Consulting X…" line upfront and then went
  // silent until all delegates had finished — the longest silence in the app,
  // during its slowest operation.
  const delegates = fanout.delegates.slice(0, MAX_FANOUT_DELEGATES);
  emit({
    type: 'thought',
    text: delegates.length === 1
      ? `Bringing in ${delegates[0].name}.`
      : `Bringing in ${delegates.slice(0, -1).map((p) => p.name).join(', ')} and ${delegates[delegates.length - 1].name}.`,
  });

  const { outcomes, needsApproval } = await runFanoutDelegates(accountId, fanout.delegates, input, emit);
  if (needsApproval) {
    emit({ type: 'needs_approval', proposal: needsApproval.proposal!, message: needsApproval.message, transcript: needsApproval.transcript });
    return;
  }

  emit({ type: 'step_start', text: `${fanout.coordinator.name} is pulling it together…` });
  const answer = await synthesizeCoordinatorAnswer(accountId, fanout.coordinator, outcomes, input.message);
  messages.push({ role: 'assistant', content: answer });
  const tokenEstimate = estimateTokens(messages);
  emit({ type: 'final', message: answer, transcript: messages, tokenEstimate });
  const level = compactionLevel(tokenEstimate);
  if (level) emit({ type: 'compaction_suggested', level, tokenEstimate });
}

async function runAgentImpl(input: RunAgentInput): Promise<AgentResult> {
  const { accountId, brandContext } = input;
  // Server-derived context handed to every tool call. The MODEL never supplies
  // these: a conversation id it could set would be forgeable, and plans, grants
  // and memory are all keyed on it.
  const toolCtx = {
    conversationId: input.conversationId ?? null,
    brandId: brandContext?.id ?? null,
    requestedBy: input.requestedBy ?? null,
    planOnly: Boolean(input.planOnly),
  };
  // Packet 6.2: only ever enter fan-out on a fresh turn — never mid-resume
  // (input.approve set) and never when the caller already pinned a single
  // explicit personaId. A resumed approval always finishes as one ordinary
  // step in the normal single-persona loop below, never a fresh fan-out —
  // that is what keeps "approve one action" from ever re-triggering N more.
  if (!input.approve && !input.personaId) {
    const fanout = await resolveCoordinatorFanout(accountId, input.personaMentions, input.message);
    if (fanout) return runCoordinatorFanout(accountId, fanout, input);
  }
  const { systemBlock: personaBlock, modelId: personaModelId } = await resolvePersonaForTurn(accountId, input.personaId, input.personaMentions);
  const allEnabledSkills = await loadEnabledSkillsForAgent(accountId);
  // Hermes picks the 1-4 that apply to THIS request instead of injecting all.
  // Pinned skills (a plan) REPLACE routing; otherwise route against this turn.
  // Filtered against what the account actually has enabled, so a stale pin
  // cannot resurrect a skill that was since turned off.
  const enabledSkills = input.pinnedSkills?.length
    ? allEnabledSkills.filter((sk) => input.pinnedSkills!.includes(sk.slug))
    : await selectSkillsForTurn(allEnabledSkills, input.message, brandContext?.name);
  // Packet 4: this account's connected, enabled external-MCP-client tools for
  // THIS turn only — a pure cached DB read (see lib/capabilities/external-mcp.ts),
  // never a network call, so it cannot add hot-path latency or hang the turn.
  const externalCaps = await loadExternalCapabilities(accountId);
  const extraTools = toolsFromCapabilities(externalCaps);
  const extraCapsByName: Record<string, Capability> = Object.fromEntries(externalCaps.map((c) => [c.name, c]));
  const system = systemPrompt(brandContext?.name, input.agentContext, input.carryover, personaBlock, skillsBlock(enabledSkills), extraTools, accountId, input.planOnly);
  const messages: ChatMessage[] = capTranscript(input.transcript || []);
  const steps: AgentStep[] = [];

  if (input.message) messages.push({ role: 'user', content: input.message });

  // Resume path: execute the one approved sensitive call, then keep looping so
  // the agent can report the outcome. Re-validated by the tool's own schema;
  // account scope is the server session's, never the client's.
  if (input.approve) {
    const { approvalId, tool, args } = input.approve;
    const approveDef = TOOLS[tool] ?? extraTools[tool];
    if (!approveDef?.sensitive) {
      return { status: 'error', message: 'That action can no longer be approved.', transcript: messages, steps };
    }
    // The user clicking "Approve & run" in chat IS the decision — this is
    // self-service confirmation of the agent's own proposal, not a second
    // operator's peer review (that's what decideApproval + the standalone
    // Approvals page are for), so flip the row pending -> approved here.
    // Best-effort by design: consumeApprovalForExecution below is the HARD
    // GATE and will refuse if this didn't actually land.
    try {
      await markApprovedByToolAndArgs(accountId, tool, args, input.requestedBy ?? null);
    } catch {
      // ignored — see comment above
    }
    // HARD GATE (Packet 0.1): consume a persisted, approved, args-matching,
    // not-yet-executed approval. Failure MUST refuse — never fall through.
    // Applies identically to an external-MCP tool (Packet 4) — its approvals
    // row was created the same way as any sensitive first-party tool's, so it
    // consumes through the exact same gate.
    try {
      await consumeApprovalForExecution(accountId, approvalId, tool, args);
    } catch (e: any) {
      if (e?.code === 'expired') {
        const def = TOOLS[tool] ?? extraTools[tool];
        const proposal = def && await reproposeAfterExpiry(accountId, tool, args, def, {
          conversationId: input.conversationId, requestedBy: input.requestedBy,
          extraCapsByName, extraTools,
        });
        if (proposal) {
          messages.push(pendingApprovalObservation(tool));
          return {
            status: 'needs_approval',
            message: `That approval lapsed before I could run it, so nothing happened. Here it is again — ${proposal.summary}`,
            proposal, transcript: messages, steps,
          };
        }
      }
      return { status: 'error', message: approvalRefusal(e), transcript: messages, steps };
    }
    // A BATCH approval resumes as a batch. The row's args are the whole batch
    // ({calls:[...]}), which is what makes the hash cover every item — so
    // handing that object to runTool as if it were one call's arguments would
    // fail validation and lose an approval the user had just granted.
    const approvedBatch = parseBatch(args);
    if (approvedBatch.kind === 'batch') {
      const results = await runBatch(approvedBatch.calls, (a) => runTool(tool, accountId, a, extraTools, extraCapsByName, brandContext?.id, toolCtx));
      const obs = batchObservation(tool, results, extraCapsByName);
      const perCall = obsLimitFor(tool, extraCapsByName);
      const obsLimit = perCall === undefined ? undefined : perCall * Math.min(approvedBatch.calls.length, 4);
      steps.push({ tool, args, observation: truncate(obs, obsLimit) });
      messages.push(observation(obs, obsLimit));
    } else {
      const res = await runTool(tool, accountId, args, extraTools, extraCapsByName, brandContext?.id, toolCtx);
      const obs = observationFor(tool, args, res, extraCapsByName);
      const obsLimit = obsLimitFor(tool, extraCapsByName);
      steps.push({ tool, args, observation: truncate(obs, obsLimit) });
      messages.push(observation(obs, obsLimit));
    }
  }

  let jsonRetries = 0;
  let unknownTools = 0;             // hallucinated tool names this turn — see MAX_UNKNOWN_TOOLS.
  const knownToolNames = [...Object.keys(TOOLS), ...Object.keys(extraTools)];
  const seen = new Set<string>();   // executed (tool+args) signatures — guards against re-calling the same read.
  let dupNudges = 0;
  const toolCalls: Record<string, number> = {};
  // Packet 6.2: clamp, never extend, the per-call step cap. Ordinary callers
  // never set maxSteps, so stepCap === MAX_STEPS for every call today.
  const stepCap = input.maxSteps && input.maxSteps > 0 ? Math.min(input.maxSteps, MAX_STEPS) : MAX_STEPS;
  // Which tool produced the most recent observation, so a model-call failure can
  // report what it was reacting to (failures after a tool differ from cold ones).
  let lastToolName: string | undefined;
  const turnDeadline = Date.now() + TURN_DEADLINE_MS;
  for (let i = 0; i < stepCap; i++) {
    // Before the step, not after: the point is to bound the wait, not to
    // notice afterwards that it was exceeded. Breaking lands in the forced
    // final below, so the turn answers from what it has.
    if (Date.now() > turnDeadline) {
      log.warn('agent: turn deadline reached, answering with what it has', {
        accountId, step: i, deadlineMs: TURN_DEADLINE_MS, afterTool: lastToolName ?? null,
      });
      break;
    }
    let raw: string;
    // Set by the router once the ai_usage row for the attempt that ANSWERED has
    // been written, so this turn can report back whether the text was usable
    // (markParseOutcome, below). May still be null when we reach the parse —
    // the usage write is fire-and-forget — which undercounts, never miscounts.
    let usageRowId: string | null = null;
    try {
      raw = await generateChat({
        system, messages, temperature: 0.2,
        conversationId: input.conversationId,
        onUsageRow: (id) => { usageRowId = id; },
        // No fixed maxOutputTokens — see AGENT_ROUTE_CEILING.
        maxOutputCeiling: AGENT_ROUTE_CEILING,
        accountId,
        task: 'reason',
        preferTier: AGENT_ROUTE_TIER,
        zoAskModel: AGENT_ZOASK_MODEL || undefined, model: AGENT_OPENCODE_MODEL,
        // Only threaded through when a persona with a model override is active,
        // so the no-persona path calls generateChat with EXACTLY the same
        // options object shape as before this change.
        ...(personaModelId ? { accountId, modelId: personaModelId } : {}),
      });
    } catch (e: unknown) {
      // Mirrors the streaming twin below — `e` was bound but never read here,
      // so this path was equally silent. Same fields, same reasoning.
      log.error('agent: model call failed', e, {
        accountId, step: i, afterTool: lastToolName ?? null, messageCount: messages.length,
      });
      return { status: 'error', message: 'LeadRail AI is temporarily unavailable. Please try again.', transcript: messages, steps };
    }

    const parsed = extractJson(raw);
    // The ONLY place that knows whether a transport-successful response was
    // usable. `ok` on the row is already true by now; parse_ok is the column
    // that separates "text came back" from "text we could act on".
    if (usageRowId) void markParseOutcome(usageRowId, Boolean(parsed));
    if (!parsed || (parsed.action !== 'tool' && parsed.action !== 'final')) {
      if (jsonRetries < MAX_JSON_RETRIES) {
        jsonRetries++;
        pushJsonRetry(messages, raw, jsonRetries, { accountId, step: i, afterTool: lastToolName });
        continue;
      }
      const salv = salvageFinalMessage(raw);
      if (salv) {
        const cleaned = stripAiMarkers(salv);
        messages.push({ role: 'assistant', content: cleaned });
        return { status: 'done', message: cleaned, transcript: messages, steps };
      }
      // The model answered (no exception, so the ai router logged a tier
      // success) but never produced valid JSON even after one correction
      // nudge, and salvage found no usable prose either. That combination is
      // invisible everywhere else: the ai router's own log only proves SOME
      // text came back, not that it was unusable. Without this line the raw
      // text that broke the contract is gone the moment this function
      // returns, and every future occurrence looks identical from the
      // outside — "I couldn't complete that request" with no way to tell
      // which tier answered or what it actually said.
      log.error('agent: model output failed JSON contract after correction', undefined, {
        accountId, step: i, afterTool: lastToolName ?? null, rawPreview: raw.slice(0, 500),
      });
      // Salvage the turn from the evidence already gathered before declaring it
      // a failure — see answerFromObservations.
      const rescued = await answerFromObservations(input, messages, personaBlock);
      if (rescued) {
        messages.push({ role: 'assistant', content: rescued });
        return { status: 'done', message: rescued, transcript: messages, steps };
      }
      return { status: 'error', message: "I couldn't complete that request. Please rephrase and try again.", transcript: messages, steps };
    }
    jsonRetries = 0;

    // Record the model's decision in the transcript so context carries forward.
    messages.push({ role: 'assistant', content: JSON.stringify(parsed) });

    if (parsed.action === 'final') {
      const draft = String(parsed.message || '').trim() || 'Done.';
      const message = stripAiMarkers(AGENT_COMPOSE
        ? await composeAnswer({
            accountId, userMessage: input.message, draft, transcript: messages,
            agentContext: input.agentContext, personaBlock,
          })
        : draft);
      // Overwrite the raw JSON envelope just pushed above with the actual
      // composed answer the user sees. Without this, the persisted transcript
      // carries the pre-compose draft (or nothing readable), so a later turn
      // "sees" only the raw tool observations, not its own prior answer, and
      // re-derives conclusions from scratch instead of building on what it
      // already told the user.
      messages[messages.length - 1] = { role: 'assistant', content: message };
      steps.push({ thought: narrationFor(parsed) });
      const tokenEstimate = estimateTokens(messages);
      return { status: 'done', message, transcript: messages, steps, tokenEstimate, compaction: compactionLevel(tokenEstimate) };
    }

    // action === 'tool'
    const tool = String(parsed.tool || '');
    const args = (parsed.args && typeof parsed.args === 'object') ? parsed.args : {};
    const def = TOOLS[tool] ?? extraTools[tool]; // Packet 4: fall back to this turn's external-MCP tools

    if (!def) {
      unknownTools++;
      steps.push({ thought: narrationFor(parsed), tool });
      messages.push(unknownToolObservation(tool, knownToolNames, unknownTools));
      continue;
    }

    // BATCH. One tool, many argument sets, ONE step — see lib/agent/batch.ts.
    // Checked before every guard below because the guards are about how many
    // DECISIONS a turn makes, and a batch is one decision however many rows it
    // touches.
    const batch = parseBatch(parsed);
    if (batch.kind === 'invalid') {
      // A malformed batch is a correctable mistake, not a dead turn: say what
      // was wrong and let the next step fix it.
      steps.push({ thought: narrationFor(parsed), tool, observation: batch.reason });
      messages.push(observation(`That batch was not valid: ${batch.reason}`));
      continue;
    }
    if (batch.kind === 'batch') {
      const calls = batch.calls;
      if (def.sensitive) {
        if (input.isDelegate) {
          const obs = `You cannot run "${tool}" — it needs the operator's approval and you are answering as a specialist. Say what you recommend and why, and let the operator's own assistant propose it.`;
          steps.push({ tool, observation: obs });
          messages.push(observation(obs));
          continue;
        }
        // ONE approval for the whole batch. The args carried on the row are the
        // batch itself, so the hash covers every item: what gets executed is
        // exactly what was approved, and a batch cannot grow between the card
        // and the run.
        const batchArgs = { calls: calls.map((c) => c.args) };
        const proposal: AgentProposal = {
          tool, title: def.title, args: batchArgs,
          summary: summarizeBatchProposal(tool, calls, extraCapsByName, extraTools),
        };
        try {
          const row = await createApproval(accountId, {
            tool, title: def.title, summary: proposal.summary, args: batchArgs,
            conversationId: input.conversationId ?? null,
            requestedBy: input.requestedBy ?? null,
            gate: capabilityFor(tool, extraCapsByName)?.gate,
          });
          proposal.approvalId = row.id;
        } catch {
          return { status: 'error', message: "I couldn't record that action for your approval, so I haven't run it. Please try again.", transcript: messages, steps };
        }
        steps.push({ thought: narrationFor(parsed), tool, args: batchArgs });
        messages.push(pendingApprovalObservation(tool));
        return { status: 'needs_approval', message: proposal.summary, proposal, transcript: messages, steps };
      }

      // Counts as ONE call against the duplicate guard, for the same reason.
      toolCalls[tool] = (toolCalls[tool] || 0) + 1;
      const results = await runBatch(calls, (a) => runTool(tool, accountId, a, extraTools, extraCapsByName, brandContext?.id, toolCtx));
      const obs = batchObservation(tool, results, extraCapsByName);
      lastToolName = tool;
      // A batch observation carries N results, so the per-call limit would clip
      // it to roughly one. Scaled, but not by the full N — the point of the
      // limit is that one step cannot swallow the context window, and a batch
      // of 25 must not be 25x the budget. Undefined stays undefined (no limit).
      const perCall = obsLimitFor(tool, extraCapsByName);
      const obsLimit = perCall === undefined ? undefined : perCall * Math.min(calls.length, 4);
      steps.push({ thought: narrationFor(parsed), tool, args: { calls: calls.map((c) => c.args) }, observation: truncate(obs, obsLimit) });
      messages.push(observation(obs, obsLimit));
      continue;
    }

    if (def.sensitive) {
      // A DELEGATE MAY NOT RAISE AN APPROVAL. The human is watching the
      // caller's turn, not this sub-run — an approval card raised from inside
      // a delegate asks them to sign off on work they never saw proposed. The
      // delegate reports what it would do; the caller proposes it properly.
      if (input.isDelegate) {
        const obs = `You cannot run "${tool}" — it needs the operator's approval and you are answering as a specialist. Say what you recommend and why, and let the operator's own assistant propose it.`;
        steps.push({ tool, args, observation: obs });
        messages.push(observation(obs));
        continue;
      }
      // STANDING GRANT (migration 062). The operator may already have said
      // "yes, for all fifty" once. enrichLead is per-lead and carries the spend
      // gate, so without this a pool of 50 is 50 cards for a decision that was
      // made at batch scale — and three of those cards lapsed unanswered in
      // production, which is what approval fatigue looks like in the data.
      //
      // Fails CLOSED: any error, expiry, exhaustion or missing conversation id
      // returns null and the normal card is raised. The failure mode in the
      // other direction is spending money nobody approved.
      const grantGate = capabilityFor(tool, extraCapsByName)?.gate;
      if (isGrantable(grantGate)) {
        const claimed = await consumeGrant(accountId, input.conversationId, tool);
        if (claimed) {
          const res = await runTool(tool, accountId, args, extraTools, extraCapsByName, brandContext?.id, toolCtx);
          // The ledger must still show this. An action covered by a grant is
          // the one nobody looked at as it happened, so it needs MORE of an
          // audit trail than a hand-approved one, not less.
          void recordExecutedApproval(accountId, {
            tool, title: def.title, summary: summarizeProposal(tool, args, extraCapsByName, extraTools),
            args, requestedBy: `grant:${claimed.grantId}`,
            grantId: claimed.grantId,
            conversationId: input.conversationId ?? null,
            decidedBy: input.requestedBy ?? null,
          }).catch((e) => log.warn('approval: grant-covered execution not audited', {
            accountId, tool, grantId: claimed.grantId, error: String(e?.message || e),
          }));

          lastToolName = tool;
          toolCalls[tool] = (toolCalls[tool] || 0) + 1;
          seen.add(`${tool}:${JSON.stringify(args)}`);
          const obs = observationFor(tool, args, res, extraCapsByName);
          steps.push({ thought: narrationFor(parsed), tool, args, observation: obs });
          messages.push(observation(obs, obsLimitFor(tool, extraCapsByName)));
          continue;
        }
      }

      const proposal: AgentProposal = { tool, title: def.title, args, summary: summarizeProposal(tool, args, extraCapsByName, extraTools) };
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
          // Sets the approval's lifetime from the gate class. An external-MCP
          // tool has no first-party capability, so gate is undefined and the
          // approval does not lapse — same behaviour it had before expiry.
          gate: capabilityFor(tool, extraCapsByName)?.gate,
        });
        proposal.approvalId = row.id;
      } catch {
        return { status: 'error', message: "I couldn't record that action for your approval, so I haven't run it. Please try again.", transcript: messages, steps };
      }
      steps.push({ thought: narrationFor(parsed), tool, args });
      // Close the gap in the transcript before it is persisted — see
      // pendingApprovalObservation.
      messages.push(pendingApprovalObservation(tool));
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

    const res = await runTool(tool, accountId, args, extraTools, extraCapsByName, brandContext?.id, toolCtx);
    const obs = observationFor(tool, args, res, extraCapsByName);
    lastToolName = tool;
    const obsLimit = obsLimitFor(tool, extraCapsByName);
    steps.push({ thought: narrationFor(parsed), tool, args, observation: truncate(obs, obsLimit) });
    messages.push(observation(obs, obsLimit));
  }

  // Forced final: rather than surface a "too many steps" error, make one last
  // call that must answer in plain language from what was already gathered.
  try {
    messages.push({ role: 'user', content: 'Stop calling tools. Using the information above, answer the user now. Respond with ONLY {"action":"final","message":"..."}.' });
    const raw = await generateChat({
      system, messages, temperature: 0.2, maxOutputTokens: 2048, zoAskModel: AGENT_ZOASK_MODEL || undefined, model: AGENT_OPENCODE_MODEL,
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
  | {
      type: 'step_start';
      text: string;
      /** This step runs ALONGSIDE its siblings rather than after them.
       *
       *  The client resolves the previous pending step whenever a new event
       *  arrives, which is right for a sequential trace — a new step means the
       *  last one ended. In a fan-out it is a lie: three step_starts in a row
       *  put a tick against the first two while all three are still running.
       *  Flagged steps are left open until their own observation lands. */
      parallel?: boolean;
      /** Identifies this step so its own observation can close it. */
      key?: string;
    }
  | { type: 'thought'; text: string }
  | { type: 'tool'; tool: string; title: string; args: Record<string, any> }
  | {
      type: 'observation'; text: string; ok: boolean; tool?: string; metrics?: Record<string, number>;
      /** Closes the `step_start` that carried this same `key`. Only fan-out
       *  delegates use it: their lines run concurrently, so "the most recent
       *  open step" is not enough to say which one just finished. */
      key?: string;
    }
  // Structured analysis of a tool's result (see Capability.findings in
  // lib/capabilities/types.ts) — emitted alongside `observation`, never
  // instead of it. `evidence` and `claim` events may appear with no matching
  // `finding` (a claim that didn't clear the bar is still emitted, just not
  // surfaced as a finding). `verdict` appears at most once per tool call and
  // only when at least one finding exists.
  | { type: 'evidence'; id: string; label: string }
  | { type: 'claim'; id: string; text: string; basis: Basis; evidenceIds: string[] }
  | { type: 'finding'; id: string; claimId: string; severity: 'low' | 'medium' | 'high'; recommendation?: string }
  | { type: 'verdict'; summary: string; findingIds: string[] }
  // Progressive preview of the compose pass, emitted token-by-token while the
  // answer is being written. Carries NO transcript and is NOT authoritative:
  // the `final` event's `message` is the truth and overwrites whatever the
  // client accumulated from these (a mid-stream compose failure falls back to
  // the route pass's draft, which will not match the deltas already sent).
  | { type: 'final_delta'; text: string }
  | { type: 'final'; message: string; transcript: ChatMessage[]; tokenEstimate?: number }
  | { type: 'needs_approval'; proposal: AgentProposal; message: string; transcript: ChatMessage[] }
  | { type: 'compaction_suggested'; level: 'soft' | 'hard'; tokenEstimate: number }
  | { type: 'error'; message: string; transcript?: ChatMessage[] };

// Stream an already-complete final answer as incremental `token` events so the
// UI can type it out, Claude-desktop style, instead of it popping in as one
// blob. Purely a presentation delay on top of a string we already have — no
// model-provider changes. Chunks on whitespace boundaries (keeps words whole)
// and paces itself so a long answer never adds more than ~1.5s of latency.
async function streamTokens(message: string, emit: (e: AgentEvent) => void): Promise<void> {
  if (!message) return;
  const chunks = message.split(/(\s+)/).filter((c) => c.length > 0);
  if (!chunks.length) return;
  const MAX_TOTAL_DELAY_MS = 1500;
  const PER_CHUNK_MS = 12;
  // If pacing every chunk at PER_CHUNK_MS would blow the total budget, batch
  // multiple chunks per emitted event so we still finish in time.
  const batchSize = Math.max(1, Math.ceil((chunks.length * PER_CHUNK_MS) / MAX_TOTAL_DELAY_MS));
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize).join('');
    // 'final_delta' is the merged event name for progressive answer text
    // (main called it 'token'). The union and AgentConsole both use
    // 'final_delta'; the 'final' event remains authoritative.
    emit({ type: 'final_delta', text: batch });
    if (i + batchSize < chunks.length) await new Promise((r) => setTimeout(r, PER_CHUNK_MS));
  }
}

/** Emit an Analysis (see analysisFor above) as its constituent SSE events, in
 *  citation order: evidence before the claims that cite it, claims before the
 *  findings that reference them, verdict last. `null`/empty analyses emit
 *  nothing — an absent finding is not itself news. */
function emitAnalysis(emit: (e: AgentEvent) => void, analysis: Analysis | null): void {
  if (!analysis) return;
  for (const ev of analysis.evidence) emit({ type: 'evidence', id: ev.id, label: ev.label });
  for (const c of analysis.claims) emit({ type: 'claim', id: c.id, text: c.text, basis: c.basis, evidenceIds: c.evidenceIds });
  for (const f of analysis.findings) emit({ type: 'finding', id: f.id, claimId: f.claimId, severity: f.severity, recommendation: f.recommendation });
  if (analysis.verdict) emit({ type: 'verdict', summary: analysis.verdict.summary, findingIds: analysis.verdict.findingIds });
}

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
async function runAgentStreamImpl(input: RunAgentInput, emit: (e: AgentEvent) => void): Promise<void> {
  const { accountId, brandContext } = input;
  // Server-derived context handed to every tool call. The MODEL never supplies
  // these: a conversation id it could set would be forgeable, and plans, grants
  // and memory are all keyed on it.
  const toolCtx = {
    conversationId: input.conversationId ?? null,
    brandId: brandContext?.id ?? null,
    requestedBy: input.requestedBy ?? null,
    planOnly: Boolean(input.planOnly),
  };
  // Packet 6.2 — same fan-out gate as runAgent above; see the comment there.
  // These four reads don't depend on each other, so they run concurrently
  // instead of as one sequential chain — on an ordinary (non-fanout) turn this
  // is the difference between ~4 back-to-back DB round-trips and one, all of
  // which used to happen before this loop's own step_start (below) could ever
  // fire. The fanout check runs speculatively alongside the rest; if it comes
  // back truthy the other three results are simply discarded for the fanout
  // path below, which is cheap relative to the latency this saves on the
  // common case.
  const [fanout, personaResult, allEnabledSkills, externalCaps] = await Promise.all([
    (!input.approve && !input.personaId)
      ? resolveCoordinatorFanout(accountId, input.personaMentions, input.message)
      : Promise.resolve(null),
    resolvePersonaForTurn(accountId, input.personaId, input.personaMentions),
    loadEnabledSkillsForAgent(accountId),
    loadExternalCapabilities(accountId),
  ]);
  if (fanout) { await runCoordinatorFanoutStream(accountId, fanout, input, emit); return; }
  const { systemBlock: personaBlock, modelId: personaModelId } = personaResult;
  // Hermes picks the 1-4 that apply to THIS request instead of injecting all.
  // This is the one hop that must stay sequential — it genuinely depends on
  // allEnabledSkills (which skills exist to route over).
  // Pinned skills (a plan) REPLACE routing; otherwise route against this turn.
  // Filtered against what the account actually has enabled, so a stale pin
  // cannot resurrect a skill that was since turned off.
  const enabledSkills = input.pinnedSkills?.length
    ? allEnabledSkills.filter((sk) => input.pinnedSkills!.includes(sk.slug))
    : await selectSkillsForTurn(allEnabledSkills, input.message, brandContext?.name);
  const extraTools = toolsFromCapabilities(externalCaps);
  const extraCapsByName: Record<string, Capability> = Object.fromEntries(externalCaps.map((c) => [c.name, c]));
  const system = systemPrompt(brandContext?.name, input.agentContext, input.carryover, personaBlock, skillsBlock(enabledSkills), extraTools, accountId, input.planOnly);
  const messages: ChatMessage[] = capTranscript(input.transcript || []);

  if (input.message) messages.push({ role: 'user', content: input.message });

  if (input.approve) {
    const { approvalId, tool, args } = input.approve;
    const approveDef = TOOLS[tool] ?? extraTools[tool];
    if (!approveDef?.sensitive) { emit({ type: 'error', message: 'That action can no longer be approved.' }); return; }
    // Self-service confirm — see the matching comment in runAgent.
    try {
      await markApprovedByToolAndArgs(accountId, tool, args, input.requestedBy ?? null);
    } catch {
      // ignored — see comment in runAgent
    }
    // HARD GATE (Packet 0.1) — see the matching comment in runAgent.
    try {
      await consumeApprovalForExecution(accountId, approvalId, tool, args);
    } catch (e: any) {
      // Same rule as runAgent: an EXPIRED approval comes straight back as a
      // fresh card rather than ending the turn. See reproposeAfterExpiry for
      // why only expiry qualifies.
      if (e?.code === 'expired') {
        const proposal = await reproposeAfterExpiry(accountId, tool, args, approveDef, {
          conversationId: input.conversationId, requestedBy: input.requestedBy,
          extraCapsByName, extraTools,
        });
        if (proposal) {
          messages.push(pendingApprovalObservation(tool));
          emit({
            type: 'needs_approval',
            proposal,
            message: `That approval lapsed before I could run it, so nothing happened. Here it is again — ${proposal.summary}`,
            transcript: messages,
          });
          return;
        }
      }
      emit({ type: 'error', message: approvalRefusal(e) });
      return;
    }
    // Batch resume — see the matching note in runAgent.
    const approvedBatch = parseBatch(args);
    if (approvedBatch.kind === 'batch') {
      emit({ type: 'tool', tool, title: `${approveDef.title} — ${approvedBatch.calls.length} at once`, args });
      const results = await runBatch(approvedBatch.calls, (a) => runTool(tool, accountId, a, extraTools, extraCapsByName, brandContext?.id, toolCtx));
      const obs = batchObservation(tool, results, extraCapsByName);
      const perCall = obsLimitFor(tool, extraCapsByName);
      const obsLimit = perCall === undefined ? undefined : perCall * Math.min(approvedBatch.calls.length, 4);
      emit({ type: 'observation', text: truncate(obs, obsLimit), ok: results.every((r) => r.ok), tool });
      messages.push(observation(obs, obsLimit));
    } else {
      emit({ type: 'tool', tool, title: approveDef.title, args });
      const res = await runTool(tool, accountId, args, extraTools, extraCapsByName, brandContext?.id, toolCtx);
      const obs = observationFor(tool, args, res, extraCapsByName);
      const obsLimit = obsLimitFor(tool, extraCapsByName);
      emit({ type: 'observation', text: truncate(obs, obsLimit), ok: res.ok, tool, metrics: res.ok ? (capabilityFor(tool, extraCapsByName)?.metrics?.(args, res.result) ?? {}) : {} });
      emitAnalysis(emit, analysisFor(tool, args, res, extraCapsByName));
      messages.push(observation(obs, obsLimit));
    }
  }

  let jsonRetries = 0;
  let unknownTools = 0;             // see MAX_UNKNOWN_TOOLS — kept identical to runAgent per the LOOP-CONTROL INVARIANT.
  const knownToolNames = [...Object.keys(TOOLS), ...Object.keys(extraTools)];
  const seen = new Set<string>();
  let dupNudges = 0;
  const toolCalls: Record<string, number> = {};
  // Packet 6.2 — identical clamp to runAgent's, per the LOOP-CONTROL INVARIANT
  // above: both variants must derive the same step cap from the same field.
  const stepCap = input.maxSteps && input.maxSteps > 0 ? Math.min(input.maxSteps, MAX_STEPS) : MAX_STEPS;
  // Which tool produced the most recent observation, so a model-call failure can
  // report what it was reacting to (failures after a tool differ from cold ones).
  let lastToolName: string | undefined;
  const turnDeadline = Date.now() + TURN_DEADLINE_MS;
  for (let i = 0; i < stepCap; i++) {
    // Before the step, not after: the point is to bound the wait, not to
    // notice afterwards that it was exceeded. Breaking lands in the forced
    // final below, so the turn answers from what it has.
    if (Date.now() > turnDeadline) {
      log.warn('agent: turn deadline reached, answering with what it has', {
        accountId, step: i, deadlineMs: TURN_DEADLINE_MS, afterTool: lastToolName ?? null,
      });
      break;
    }
    // Live "working" step BEFORE the blocking model call (from main): without
    // it the first event of a step only lands after generateChat returns, so the
    // trace renders in a burst at the end instead of showing motion.
    emit({ type: 'step_start', text: i === 0 ? 'Thinking through your request…' : 'Working through the next step…' });
    let raw: string;
    // Set by the router once the ai_usage row for the attempt that ANSWERED has
    // been written, so this turn can report back whether the text was usable
    // (markParseOutcome, below). May still be null when we reach the parse —
    // the usage write is fire-and-forget — which undercounts, never miscounts.
    let usageRowId: string | null = null;
    try {
      raw = await generateChat({
        system, messages, temperature: 0.2,
        conversationId: input.conversationId,
        onUsageRow: (id) => { usageRowId = id; },
        // No fixed maxOutputTokens — see AGENT_ROUTE_CEILING.
        maxOutputCeiling: AGENT_ROUTE_CEILING,
        accountId,
        task: 'reason',
        preferTier: AGENT_ROUTE_TIER,
        zoAskModel: AGENT_ZOASK_MODEL || undefined, model: AGENT_OPENCODE_MODEL,
        ...(personaModelId ? { accountId, modelId: personaModelId } : {}),
      });
    } catch (e: unknown) {
      // Never swallow this. It is the single most common way a run dies, and an
      // unbound `catch {}` here made every such failure undiagnosable: the SSE
      // route is deliberately not withApi-wrapped, so this log line is the ONLY
      // record that the run failed at all. `step` matters — failures after a
      // tool observation behave differently from failures on the opening call.
      log.error('agent stream: model call failed', e, {
        accountId, step: i, afterTool: lastToolName ?? null, messageCount: messages.length,
      });
      emit({ type: 'error', message: 'LeadRail AI is temporarily unavailable. Please try again.' });
      return;
    }

    const parsed = extractJson(raw);
    // The ONLY place that knows whether a transport-successful response was
    // usable. `ok` on the row is already true by now; parse_ok is the column
    // that separates "text came back" from "text we could act on".
    if (usageRowId) void markParseOutcome(usageRowId, Boolean(parsed));
    if (!parsed || (parsed.action !== 'tool' && parsed.action !== 'final')) {
      if (jsonRetries < MAX_JSON_RETRIES) {
        jsonRetries++;
        pushJsonRetry(messages, raw, jsonRetries, { accountId, step: i, afterTool: lastToolName });
        continue;
      }
      const salv = salvageFinalMessage(raw);
      if (salv) {
        const cleaned = stripAiMarkers(salv);
        messages.push({ role: 'assistant', content: cleaned });
        await streamTokens(cleaned, emit);
        emit({ type: 'final', message: cleaned, transcript: messages });
        return;
      }
      // Same gap as runAgent's twin above, and it matters MORE here: the SSE
      // route is deliberately not withApi-wrapped (see the catch block above),
      // so before this line there was no record ANYWHERE that a run failed
      // this way — not in app_logs, not in the ai router's own log (which only
      // proves a tier returned text, not that the text was usable).
      log.error('agent stream: model output failed JSON contract after correction', undefined, {
        accountId, step: i, afterTool: lastToolName ?? null, rawPreview: raw.slice(0, 500),
      });
      // Salvage from the evidence already gathered — see answerFromObservations.
      const rescued = await answerFromObservations(input, messages, personaBlock);
      if (rescued) {
        messages.push({ role: 'assistant', content: rescued });
        await streamTokens(rescued, emit);
        emit({ type: 'final', message: rescued, transcript: messages });
        return;
      }
      emit({ type: 'error', message: "I couldn't complete that request. Please rephrase and try again.", transcript: messages });
      return;
    }
    jsonRetries = 0;
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
      message = stripAiMarkers(message);
      // See the matching comment in runAgent: overwrite the raw JSON envelope
      // with the actual composed answer so a later turn builds on what the
      // user was actually shown instead of re-deriving it from raw observations.
      messages[messages.length - 1] = { role: 'assistant', content: message };
      const tokenEstimate = estimateTokens(messages);
      emit({ type: 'final', message, transcript: messages, tokenEstimate });
      const level = compactionLevel(tokenEstimate);
      if (level) emit({ type: 'compaction_suggested', level, tokenEstimate });
      return;
    }

    const tool = String(parsed.tool || '');
    const args = (parsed.args && typeof parsed.args === 'object') ? parsed.args : {};
    const def = TOOLS[tool] ?? extraTools[tool]; // Packet 4: fall back to this turn's external-MCP tools

    if (!def) {
      unknownTools++;
      emit({ type: 'observation', text: `Unknown tool "${tool}".`, ok: false });
      messages.push(unknownToolObservation(tool, knownToolNames, unknownTools));
      continue;
    }

    // BATCH — the streaming half of the branch in runAgent. Identical rules;
    // see the note there. Kept in step per the LOOP-CONTROL INVARIANT.
    const batch = parseBatch(parsed);
    if (batch.kind === 'invalid') {
      emit({ type: 'observation', text: `That batch was not valid: ${batch.reason}`, ok: false });
      messages.push(observation(`That batch was not valid: ${batch.reason}`));
      continue;
    }
    if (batch.kind === 'batch') {
      const calls = batch.calls;
      if (def.sensitive) {
        if (input.isDelegate) {
          const obs = `You cannot run "${tool}" — it needs the operator's approval and you are answering as a specialist. Say what you recommend and why, and let the operator's own assistant propose it.`;
          emit({ type: 'observation', text: obs, ok: false });
          messages.push(observation(obs));
          continue;
        }
        const batchArgs = { calls: calls.map((c) => c.args) };
        const proposal: AgentProposal = {
          tool, title: def.title, args: batchArgs,
          summary: summarizeBatchProposal(tool, calls, extraCapsByName, extraTools),
        };
        try {
          const row = await createApproval(accountId, {
            tool, title: def.title, summary: proposal.summary, args: batchArgs,
            conversationId: input.conversationId ?? null,
            requestedBy: input.requestedBy ?? null,
            gate: capabilityFor(tool, extraCapsByName)?.gate,
          });
          proposal.approvalId = row.id;
        } catch {
          emit({ type: 'error', message: "I couldn't record that action for your approval, so I haven't run it. Please try again." });
          return;
        }
        messages.push(pendingApprovalObservation(tool));
        emit({ type: 'needs_approval', proposal, message: proposal.summary, transcript: messages });
        return;
      }

      toolCalls[tool] = (toolCalls[tool] || 0) + 1;
      emit({ type: 'tool', tool, title: `${def.title} — ${calls.length} at once`, args: { calls: calls.map((c) => c.args) } });
      const results = await runBatch(calls, (a) => runTool(tool, accountId, a, extraTools, extraCapsByName, brandContext?.id, toolCtx));
      const obs = batchObservation(tool, results, extraCapsByName);
      const perCall = obsLimitFor(tool, extraCapsByName);
      const obsLimit = perCall === undefined ? undefined : perCall * Math.min(calls.length, 4);
      emit({
        type: 'observation', text: truncate(obs, obsLimit), tool,
        // ok only when EVERY call worked: a batch that half-failed must not
        // render with a plain tick, which is what "mostly fine" looks like.
        ok: results.every((r) => r.ok),
      });
      messages.push(observation(obs, obsLimit));
      continue;
    }

    if (def.sensitive) {
      // Same rule as runAgent — see the note there.
      if (input.isDelegate) {
        const obs = `You cannot run "${tool}" — it needs the operator's approval and you are answering as a specialist. Say what you recommend and why, and let the operator's own assistant propose it.`;
        emit({ type: 'observation', text: obs, ok: false });
        messages.push(observation(obs));
        continue;
      }
      // STANDING GRANT (migration 062). The operator may already have said
      // "yes, for all fifty" once. enrichLead is per-lead and carries the spend
      // gate, so without this a pool of 50 is 50 cards for a decision that was
      // made at batch scale — and three of those cards lapsed unanswered in
      // production, which is what approval fatigue looks like in the data.
      //
      // Fails CLOSED: any error, expiry, exhaustion or missing conversation id
      // returns null and the normal card is raised. The failure mode in the
      // other direction is spending money nobody approved.
      const grantGate = capabilityFor(tool, extraCapsByName)?.gate;
      if (isGrantable(grantGate)) {
        const claimed = await consumeGrant(accountId, input.conversationId, tool);
        if (claimed) {
          const res = await runTool(tool, accountId, args, extraTools, extraCapsByName, brandContext?.id, toolCtx);
          // The ledger must still show this. An action covered by a grant is
          // the one nobody looked at as it happened, so it needs MORE of an
          // audit trail than a hand-approved one, not less.
          void recordExecutedApproval(accountId, {
            tool, title: def.title, summary: summarizeProposal(tool, args, extraCapsByName, extraTools),
            args, requestedBy: `grant:${claimed.grantId}`,
            grantId: claimed.grantId,
            conversationId: input.conversationId ?? null,
            decidedBy: input.requestedBy ?? null,
          }).catch((e) => log.warn('approval: grant-covered execution not audited', {
            accountId, tool, grantId: claimed.grantId, error: String(e?.message || e),
          }));

          lastToolName = tool;
          toolCalls[tool] = (toolCalls[tool] || 0) + 1;
          seen.add(`${tool}:${JSON.stringify(args)}`);
          const obs = observationFor(tool, args, res, extraCapsByName);
          const obsLimit = obsLimitFor(tool, extraCapsByName);
          // Same events a normal tool call emits, so the live trace shows the
          // work rather than going silent just because nobody was asked.
          emit({ type: 'observation', text: truncate(obs, obsLimit), ok: res.ok, tool, metrics: res.ok ? (capabilityFor(tool, extraCapsByName)?.metrics?.(args, res.result) ?? {}) : {} });
          emitAnalysis(emit, analysisFor(tool, args, res, extraCapsByName));
          messages.push(observation(obs, obsLimit));
          continue;
        }
      }

      const proposal: AgentProposal = { tool, title: def.title, args, summary: summarizeProposal(tool, args, extraCapsByName, extraTools) };
      // Additive persistence — see the matching comment in runAgent above.
      // Best-effort; never blocks the existing needs_approval/resume flow.
      // REQUIRED, not best-effort — see the matching comment in runAgent.
      try {
        const row = await createApproval(accountId, {
          tool, title: def.title, summary: proposal.summary, args,
          conversationId: input.conversationId ?? null,
          requestedBy: input.requestedBy ?? null,
          // Sets the approval's lifetime from the gate class. An external-MCP
          // tool has no first-party capability, so gate is undefined and the
          // approval does not lapse — same behaviour it had before expiry.
          gate: capabilityFor(tool, extraCapsByName)?.gate,
        });
        proposal.approvalId = row.id;
      } catch {
        emit({ type: 'error', message: "I couldn't record that action for your approval, so I haven't run it. Please try again." });
        return;
      }
      // Close the gap in the transcript before it is persisted — see
      // pendingApprovalObservation.
      messages.push(pendingApprovalObservation(tool));
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
    const res = await runTool(tool, accountId, args, extraTools, extraCapsByName, brandContext?.id, toolCtx);
    const obs = observationFor(tool, args, res, extraCapsByName);
    const obsLimit = obsLimitFor(tool, extraCapsByName);
    emit({ type: 'observation', text: truncate(obs, obsLimit), ok: res.ok, tool, metrics: res.ok ? (capabilityFor(tool, extraCapsByName)?.metrics?.(args, res.result) ?? {}) : {} });
    emitAnalysis(emit, analysisFor(tool, args, res, extraCapsByName));
    messages.push(observation(obs, obsLimit));
  }

  // Forced final rather than a "too many steps" error.
  try {
    messages.push({ role: 'user', content: 'Stop calling tools. Using the information above, answer the user now. Respond with ONLY {"action":"final","message":"..."}.' });
    emit({ type: 'step_start', text: 'Putting the answer together…' });
    const raw = await generateChat({
      system, messages, temperature: 0.2, maxOutputTokens: 2048, zoAskModel: AGENT_ZOASK_MODEL || undefined, model: AGENT_OPENCODE_MODEL,
      ...(personaModelId ? { accountId, modelId: personaModelId } : {}),
    });
    const p = extractJson(raw);
    if (p?.action === 'final' && p.message) {
      const finalMessage = stripAiMarkers(String(p.message));
      messages.push({ role: 'assistant', content: finalMessage });
      await streamTokens(finalMessage, emit);
      emit({ type: 'final', message: finalMessage, transcript: messages });
      return;
    }
  } catch { /* fall through */ }
  emit({ type: 'error', message: 'I gathered the details but had trouble summarizing. Please ask again a bit more specifically.', transcript: messages });
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
      zoAskModel: AGENT_ZOASK_MODEL || undefined,
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


// ---------------------------------------------------------------------------
// TURN LOGGING
//
// Until now the only durable record a chat turn left behind was an error line:
// the model call throwing, or the JSON contract failing. A turn that "worked"
// but answered the wrong question, drifted off scope, or took ninety seconds
// wrote nothing anywhere — so "look at the logs and see what was asked and what
// came back" had no logs to look at, and every quality report had to be
// reproduced by hand from a screenshot.
//
// These wrappers close that. One persisted row per turn, carrying the input,
// the tools that actually ran, the outcome, the shape of the answer, and where
// the wall-clock went. Written through log.request(), which is the sink that
// persists info rows (log.info is console-only), so the rows show up in
// GET /api/logs alongside HTTP request lines and are account-scoped by the
// same rules.
//
// Deliberately bounded: previews are clipped, never the full transcript. The
// full transcript already lives in agent_conversations; this table is for
// scanning many turns quickly, not for storing a second copy of the chat.
// ---------------------------------------------------------------------------

const TURN_LOG_PREVIEW_CHARS = 300;

function preview(text: string | undefined, limit = TURN_LOG_PREVIEW_CHARS): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}

function logTurn(
  input: RunAgentInput,
  fields: {
    variant: 'stream' | 'json';
    outcome: string;
    startedAt: number;
    steps: AgentStep[];
    answer?: string;
    firstEventMs?: number | null;
  },
): void {
  const durationMs = Date.now() - fields.startedAt;
  const tools = fields.steps.filter((st) => st.tool).map((st) => st.tool as string);
  log.request(
    {
      route: `agent:${fields.variant}`,
      method: 'TURN',
      accountId: input.accountId,
      actorEmail: input.requestedBy ?? null,
      durationMs,
      message: `agent turn: ${fields.outcome}`,
      detail: {
        outcome: fields.outcome,
        // What the user actually typed — the "input" half of the pair.
        input: preview(input.message),
        inputChars: input.message?.length ?? 0,
        // What we did about it.
        toolCalls: tools,
        stepCount: fields.steps.length,
        // What came back — the "output" half.
        answer: preview(fields.answer),
        answerChars: fields.answer?.length ?? 0,
        // Where the time went. firstEventMs is time-to-first-visible-event on
        // the stream path: a large gap between it and durationMs is the model
        // ladder being slow, a small one is the pre-loop context assembly.
        durationMs,
        firstEventMs: fields.firstEventMs ?? null,
        brand: input.brandContext?.name ?? null,
        personaId: input.personaId ?? null,
        conversationId: input.conversationId ?? null,
        resumed: Boolean(input.transcript?.length),
        approved: input.approve?.tool ?? null,
      },
    },
    fields.outcome === 'error' ? 'warn' : 'info',
  );
}

/** LeadRail AI, non-streaming. Thin wrapper over the loop that records one
 *  durable line per turn (see TURN LOGGING above); behaviour is unchanged. */
export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const startedAt = Date.now();
  const turnId = `${input.accountId}:${startedAt}:${Math.round(performance.now())}`;
  beginDelegationScope(turnId);
  setDelegationContext({ id: turnId, isDelegate: Boolean(input.isDelegate) });
  try {
    const result = await runAgentImpl(input);
    logTurn(input, {
      variant: 'json',
      outcome: result.status,
      startedAt,
      steps: result.steps,
      answer: result.message,
    });
    return result;
  } catch (e) {
    logTurn(input, { variant: 'json', outcome: 'threw', startedAt, steps: [] });
    throw e;
  } finally {
    endDelegationScope(turnId);
    setDelegationContext(null);
  }
}

/** LeadRail AI, streaming. Same wrapper, plus time-to-first-event: the emit
 *  channel is tapped rather than the loop being instrumented, so the loop's
 *  own control flow is untouched. */
export async function runAgentStream(input: RunAgentInput, emit: (e: AgentEvent) => void): Promise<void> {
  const startedAt = Date.now();
  const turnId = `${input.accountId}:${startedAt}:${Math.round(performance.now())}`;
  beginDelegationScope(turnId);
  setDelegationContext({ id: turnId, isDelegate: Boolean(input.isDelegate) });
  let firstEventMs: number | null = null;
  let outcome = 'incomplete';
  let answer: string | undefined;
  const steps: AgentStep[] = [];

  const tap = (e: AgentEvent) => {
    if (firstEventMs === null) firstEventMs = Date.now() - startedAt;
    if (e.type === 'tool') steps.push({ tool: e.tool, args: e.args });
    else if (e.type === 'final') { outcome = 'done'; answer = e.message; }
    else if (e.type === 'needs_approval') { outcome = 'needs_approval'; answer = e.message; }
    else if (e.type === 'error') { outcome = 'error'; answer = e.message; }
    emit(e);
  };

  try {
    await runAgentStreamImpl(input, tap);
  } catch (e) {
    outcome = 'threw';
    throw e;
  } finally {
    logTurn(input, { variant: 'stream', outcome, startedAt, steps, answer, firstEventMs });
    endDelegationScope(turnId);
    setDelegationContext(null);
  }
}

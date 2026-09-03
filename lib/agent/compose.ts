/**
 * Compose pass — the user-facing answer.
 *
 * The route pass (lib/agent/loop.ts) runs at temperature 0.2, maxOutputTokens 700,
 * and wraps its output in a JSON envelope {"action":"final","message":"..."}.
 * That envelope flattens prose: markdown, newlines, lists, and structure are escaped
 * into a JSON string, so the route pass is good at deciding what to do but poor at
 * writing the final answer.
 *
 * This module runs a second pass with a heavier model, temperature 0.6,
 * maxOutputTokens 2000, and no tools/JSON wrapper, to rewrite the route pass's
 * draft into the answer the user actually reads. Any failure falls back to the
 * draft verbatim, so a compose outage degrades to today's output, never to an error.
 */

import { BUDGET } from '@/lib/ai/context-budget';
import { generateChat, streamChat, type ChatMessage } from '@/lib/ai/router';
import { stripAiMarkers, HUMANIZE_RULES } from '@/lib/ai/humanizer';
import { StoppedError } from '@/lib/ai/abort';

// Upper bound on the compose budget. The model's own ceiling is used when it is
// lower; this only stops an enormous-output model from being asked for far more
// than a chat answer ever needs.
// Ceiling, not a budget: resolveMaxOutputTokens takes min(model capability,
// this). Raised from 8000 so the answer the user reads is bounded by what the
// model can actually produce rather than by a number we picked.
const COMPOSE_CEILING = Number(process.env.AGENT_COMPOSE_CEILING || 32000);

// Second, independent kill switch (Packet 8.1c). AGENT_COMPOSE=0 disables the
// compose pass entirely; AGENT_COMPOSE_STREAM=0 keeps compose but takes the
// buffered path, so `onDelta` is ignored and no final_delta events are emitted.
const AGENT_COMPOSE_STREAM = process.env.AGENT_COMPOSE_STREAM !== '0';

export interface ComposeInput {
  accountId: string;
  /** The user's most recent instruction. */
  userMessage?: string;
  /** The route pass's own draft (parsed.message from action:"final"). */
  draft: string;
  /** The route pass transcript — carries OBSERVATION lines with real data. */
  transcript: ChatMessage[];
  /** Grounding block already assembled by loadAgentContext. */
  agentContext?: string;
  /** Persona system block, when one is active. */
  personaBlock?: string;
  /** Absolute epoch-ms deadline for the turn this call belongs to. Optional/
   *  additive: a caller that omits it gets byte-identical (unbounded)
   *  behaviour, matching generateChat/streamChat. See lib/ai/deadline.ts.
   *  A call made while a user is waiting on this turn must carry ITS
   *  deadline — never a separately invented one. */
  deadlineAt?: number;
  /** External abort for an in-flight cooperative stop (lib/agent/
   *  stop-watch.ts). Optional/additive: omitted, behaviour is unchanged. See
   *  the note on the catch block below for why a stop-caused abort is the
   *  ONE failure this function does not swallow into the draft. */
  signal?: AbortSignal;
}

/** Rewrite the route pass's draft into the answer the user actually reads.
 *  Falls back to the draft verbatim on ANY failure — a compose outage must
 *  degrade to today's output, never to an error.
 *
 *  Pass `onDelta` to stream the answer as it is written. Deltas are a
 *  PROGRESSIVE PREVIEW only: the returned string is authoritative and the
 *  caller must overwrite whatever it accumulated (a mid-stream failure returns
 *  the draft, which will not match the deltas already emitted). With no
 *  `onDelta` — or with AGENT_COMPOSE_STREAM=0 — this is byte-identical to the
 *  buffered path. */
export async function composeAnswer(
  input: ComposeInput,
  onDelta?: (chunk: string) => void,
): Promise<string> {
  try {
    const systemPrompt = buildSystemPrompt(input);
    const userTurn = buildUserTurn(input);

    const callOpts = {
      system: systemPrompt,
      messages: [{ role: 'user' as const, content: userTurn }],
      temperature: 0.6,
      // No fixed budget. maxOutputTokens is deliberately OMITTED so the answer
      // length follows the capability of whichever model actually gets selected
      // (migration 038 / resolveMaxOutputTokens): a model that can emit 8k is
      // not capped at 2k, and one capped lower is never over-requested. The
      // ceiling is a cost/latency bound, not a quality bound — override with
      // AGENT_COMPOSE_CEILING.
      maxOutputCeiling: COMPOSE_CEILING,
      accountId: input.accountId,
      task: 'draft',
      preferTier: 'heavy' as const,
      deadlineAt: input.deadlineAt,
      signal: input.signal,
    };

    const response = onDelta && AGENT_COMPOSE_STREAM
      ? await streamChat(callOpts, onDelta)
      : await generateChat(callOpts);

    // Both resolve to a string; no extraction layer needed. stripAiMarkers is
    // the same post-process generation.ts runs on every outreach draft — the
    // chat answer is user-facing text too, so it gets the identical pass
    // instead of only ever being described in the tone rules below.
    if (!response || !response.trim()) return stripAiMarkers(input.draft);
    return stripAiMarkers(response.trim());
  } catch (e) {
    // Every other failure here degrades silently to the draft — that is the
    // whole point of this function, and it is correct for a real outage or a
    // deadline. A STOP is the one exception: rethrown so the caller
    // (lib/agent/loop.ts) can end the turn through the SAME stop-salvage
    // path (stopResult/emitStopFinal) the between-steps check already uses,
    // instead of silently completing with the pre-compose draft as if
    // nothing had happened — see CLAUDE.md: no second termination path.
    if (e instanceof StoppedError) throw e;
    return stripAiMarkers(input.draft);
  }
}

function buildSystemPrompt(input: ComposeInput): string {
  const parts: string[] = [];

  if (input.personaBlock && input.personaBlock.trim()) {
    parts.push(input.personaBlock.trim());
  }

  // BACKGROUND, NOT MATERIAL. This block is the same grounding briefing the
  // route pass gets — platform description, venture profile, account snapshot
  // (venture names, lead count, campaign count), connected social accounts,
  // recalled memory. Pasted in unlabelled, the compose model read it as
  // content to include, and it showed: asked to "pull 2 more leads and enrich
  // them", the assistant answered with the leads AND then recited "You have 41
  // leads on file across your 3 ventures… Your connected social accounts
  // include…" — three paragraphs of briefing nobody asked for, copied almost
  // verbatim out of this block. The header below is what tells the model this
  // is reference material for resolving names and nothing else.
  // C10 — agentContext (the full grounding block: platform brief, venture
  // profile, account snapshot, connected socials, recalled memory, attached
  // documents) used to be pasted in here wholesale, labelled "reference
  // only". It did not stay reference-only in practice: asked to "pull 2 more
  // leads and enrich them", the model answered with the leads and then
  // recited "You have 41 leads on file across your 3 ventures… Your
  // connected social accounts include…" — three unrequested paragraphs lifted
  // almost verbatim out of this block, despite the guardrail text above.
  //
  // Compose's job is to rewrite the ROUTE PASS'S OWN DRAFT using the
  // OBSERVATIONS as evidence — both of which already carry whatever names,
  // ids and terms the route pass needed (it had the full agentContext when
  // it wrote the draft, and any id a tool call resolved is in the
  // observation that returned it). There is no fact compose needs that is in
  // agentContext and NOT already in one of those two — so nothing from it is
  // kept: the smallest correct piece turned out to be none of it, and the
  // block is dropped entirely rather than re-summarized or partially kept.
  // If a future defect surfaces a fact compose genuinely cannot resolve
  // without it, that is a case for the draft or an observation to carry the
  // fact explicitly, not for this block to come back.

  parts.push(`You are the operator copilot. Write the final answer to the user based on the provided draft and observations.

ANSWER THE QUESTION THAT WAS ASKED — nothing else:
- The user's question sets the scope of your reply. Do not add a status roundup, a summary of the account, a list of what is connected, or "here's what else I noticed" unless they asked for it.
- The draft decides WHAT you say; you decide how well it reads. Do not introduce a subject the draft and the observations do not both support.
- If the request had several parts and only some were done, say plainly which parts are done and which are not. Never pad the gap with background.

NEVER FABRICATE:
- Every name, email address, company, number, date and status must come from an OBSERVATION line. If it is not there, it does not go in the answer.
- Placeholder-looking data in an observation (example.com addresses, "newlead1@…", "Unknown", masked or locked fields) is reported as exactly that — masked, unrevealed, or a placeholder record. Never present it as a real contact, and never dress it up with details the observation does not contain.
- An action that needs approval has NOT happened yet. If the turn ended at a proposal, say what you are about to do and that it is waiting on them — never describe its results.
- If the observations do not answer the question, say what is missing and what you would need to do next. That is a good answer; an invented one is not.

Instructions:
- Write as the operator copilot: warm, direct, plain language, no filler preamble.
- Use markdown naturally — short paragraphs, lists only when the content is genuinely a list, a table when comparing.
- Lead with the answer. No "Great question!", no restating the request, no summary of what you just did unless asked.
- Never mention tools, internal names, vendors, model names, or the two-pass architecture.
- Match length to the question: one line for a one-line answer, more when it earns it.
- Output plain text only. No JSON, no wrapper object.
${HUMANIZE_RULES.map((r) => `- ${r}`).join('\n')}`);

  return parts.join('\n\n');
}

function buildUserTurn(input: ComposeInput): string {
  const observationBlock = extractObservationBlock(input.transcript);
  const parts: string[] = [];

  if (input.userMessage && input.userMessage.trim()) {
    parts.push(`## User question\n${input.userMessage.trim()}`);
  }

  parts.push(`## Draft\n${input.draft.trim()}`);
  parts.push(`## Observations\n${observationBlock || 'No observations available.'}`);

  return parts.join('\n\n');
}

/** @deprecated Compose no longer packs observations up to a character
 *  budget — see extractObservationBlock below. Kept only so nothing that
 *  still imports this constant (lib/agent/loop.ts, the capability contract
 *  test) fails to compile; its value is unused by this file now. */
export const OBSERVATION_BLOCK_CHARS =
  Number(process.env.AGENT_OBSERVATION_BLOCK_CHARS) || BUDGET.composeBlockChars;

/** C10 — how many of the most recent OBSERVATION: messages compose reads,
 *  full stop. This replaces a running character budget (up to
 *  composeBlockChars, 160k) that packed in every observation newest-first
 *  until it filled — on a turn that called several tools, the compose call
 *  ended up nearly as large as the step call it was meant to summarize.
 *  Two is enough for the turns compose actually has to write about: the
 *  answer is about what just happened, and what just happened is the last
 *  one or two tool results — everything the route pass reasoned about along
 *  the way is still reflected in its OWN draft, which compose also receives
 *  in full. */
const LAST_N_OBSERVATIONS = 2;

/**
 * Per-observation safety ceiling, applied only when a single observation is
 * unusually large. Kept generous — most observations are far smaller than
 * this — because with only two observations reaching compose at all there is
 * no longer a shared budget to protect; this exists solely so one
 * pathological result (a capability with a very large `observationLimit`,
 * e.g. readDocument's ~44k) cannot dominate an otherwise-small prompt.
 */
const MAX_SINGLE_OBSERVATION_CHARS = 40_000;

/**
 * Last two OBSERVATION: entries from the route-pass transcript, newest
 * first, for the compose pass to write from.
 *
 * THE DIGEST-THEN-JSON LAYOUT THIS RELIES ON. successObservation() in
 * lib/agent/loop.ts builds each observation as `${digest}\n${raw}` when the
 * capability declares a `digest()` — a short, truthful, plain-language line
 * FIRST, with the full JSON result after it under the same single
 * `OBSERVATION: ` prefix (raw JSON alone, no digest, for a capability that
 * doesn't declare one, or `ERROR: ...` for a failed call). That ordering is
 * why simply keeping an observation whole is safe even under the per-entry
 * ceiling below: the digest is the earliest, most load-bearing text, so a
 * cut that lands past it removes only the JSON tail, never the summary a
 * human would read first.
 *
 * This is a deliberately MINIMAL local reimplementation of "find the
 * OBSERVATION: lines" — not an import of successObservation or its digest
 * logic from lib/agent/loop.ts. loop.ts imports composeAnswer (this module)
 * to run the compose pass itself, so importing back from here would be a
 * cycle; the actual parsing needed on this side is a single startsWith
 * check, not worth breaking that cycle for.
 */
function extractObservationBlock(transcript: ChatMessage[]): string {
  const kept: string[] = [];

  // Iterate from newest to oldest (end of transcript) and stop at two.
  for (let i = transcript.length - 1; i >= 0 && kept.length < LAST_N_OBSERVATIONS; i--) {
    const message = transcript[i];
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content.startsWith('OBSERVATION: ')) continue;
    kept.push(
      content.length > MAX_SINGLE_OBSERVATION_CHARS
        ? `${content.slice(0, MAX_SINGLE_OBSERVATION_CHARS)}\n[…truncated — this single observation exceeded ${MAX_SINGLE_OBSERVATION_CHARS} characters.]`
        : content,
    );
  }

  // kept is newest-first as collected.
  return kept.join('\n');
}

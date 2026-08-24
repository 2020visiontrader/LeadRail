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

import { generateChat, streamChat, type ChatMessage } from '@/lib/ai/router';
import { stripAiMarkers, HUMANIZE_RULES } from '@/lib/ai/humanizer';

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
  } catch {
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
  if (input.agentContext && input.agentContext.trim()) {
    parts.push(
      [
        'BACKGROUND BRIEFING — reference only.',
        'This is context so you can resolve names, ids and terminology. It is NOT the answer and it is NOT news to the user: they already know what ventures they run and what they have connected.',
        'NEVER recite, summarise, or volunteer anything from this block. Use a fact from it only when the user\'s question actually asks for it.',
        '',
        input.agentContext.trim(),
      ].join('\n'),
    );
  }

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

/** Total characters of OBSERVATION text handed to the compose pass, newest
 *  first. This is the REAL ceiling on how much evidence the final answer can be
 *  written from — a per-observation budget above it is not bigger, it is just
 *  re-clipped here, which is precisely how analyzeBrand's strategy went missing.
 *
 *  Sized against MAX_STEPS (10): a turn that calls ten tools must not have its
 *  early findings silently dropped before the answer is composed. ~32k chars is
 *  roughly 8k tokens, which every model on the ladder carries comfortably.
 *
 *  EXPORTED so lib/agent/loop.ts and the capability contract test assert
 *  against this number rather than restating it. The one thing that must never
 *  happen again is two caps in series disagreeing in silence. */
//
// Raised with the per-observation limit and the transcript budget: 32k chars is
// ~8k tokens, which was sized for the weakest tier on the ladder rather than
// for the Claude model that actually composes the answer. On a turn that calls
// a dozen tools it silently dropped the earliest findings before the answer was
// written — which reads as the assistant ignoring half of what it just looked up.
export const OBSERVATION_BLOCK_CHARS =
  Number(process.env.AGENT_OBSERVATION_BLOCK_CHARS) || 160_000;

function extractObservationBlock(transcript: ChatMessage[]): string {
  const lines: string[] = [];
  let totalLength = 0;
  const MAX = OBSERVATION_BLOCK_CHARS;

  // Iterate from newest to oldest (end of transcript)
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i];
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content.startsWith('OBSERVATION: ')) continue;

    if (totalLength + content.length > MAX) {
      if (lines.length === 0) {
        // First (newest) line exceeds cap — truncate it to fit exactly.
        const remaining = MAX - totalLength;
        lines.push(content.slice(0, remaining));
        totalLength += remaining;
      }
      break; // Stop adding more lines once cap is reached
    }

    lines.push(content);
    totalLength += content.length;
    if (totalLength >= MAX) break;
  }

  // lines are in newest-first order as collected
  return lines.join('\n');
}

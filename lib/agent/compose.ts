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
const COMPOSE_CEILING = Number(process.env.AGENT_COMPOSE_CEILING || 8000);

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

  if (input.agentContext && input.agentContext.trim()) {
    parts.push(input.agentContext.trim());
  }

  parts.push(`You are the operator copilot. Write the final answer to the user based on the provided draft and observations.

Instructions:
- Write as the operator copilot: warm, direct, plain language, no filler preamble.
- Ground every factual claim in the OBSERVATION lines. Never invent numbers, leads, campaigns, or statuses. If the data isn't there, say what's missing.
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

function extractObservationBlock(transcript: ChatMessage[]): string {
  const lines: string[] = [];
  let totalLength = 0;
  const MAX = 6000;

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

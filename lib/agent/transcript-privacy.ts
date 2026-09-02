// The one boundary between the model's private reasoning and the browser.
//
// WHAT `plan` IS. Commit 541733d made `plan` the expected first field of every
// envelope and told the model, in the system prompt, that it is "shown to NO
// ONE — not the user, not the trace — so length is never penalised there".
// That wording is an invitation to be candid: what it is uncertain about, what
// it has not checked, why this tool rather than another.
//
// WHAT WAS ACTUALLY HAPPENING. The whole envelope is stringified into the
// server's `messages` array (lib/agent/loop.ts, `JSON.stringify(parsed)`) —
// deliberately, because a later step in the same turn must be able to read what
// an earlier one worked out. But that same array was then handed to the browser
// verbatim: on the SSE `final` and `needs_approval` events, in the JSON route's
// response body, in GET /api/agent/conversations/:id on every reload, and in
// the /rerun response. Nothing RENDERED it, so the guarantee in force was "not
// displayed" — strictly weaker than what the prompt promised.
//
// WHY STRIPPING IS SAFE. Conversation state is server-owned: no route reads a
// transcript out of a request body (verified across app/api/**), and both agent
// routes reload it from `agent_conversations` by conversationId — see the
// "The client NEVER sends transcript content (Packet 0.2)" comments on
// app/api/agent/route.ts and app/api/agent/stream/route.ts. The browser's copy
// is display-only, consumed by `transcriptToTurns` in
// src/components/AgentConsole.tsx. So the client-bound copy can lose `plan`
// without touching resume, approval-resume, or persistence.
//
// WHY IT LIVES HERE AND NOT IN THE LOOP. The loops' `messages` array is the
// SERVER's copy, and the stream route saves the very object it emits
// (`finalTranscript = e.transcript`, then `saveConversation`). Stripping inside
// the loop would strip what gets persisted, which breaks requirement 1. The
// strip therefore belongs at each place the transcript crosses to a client —
// and there are four of them, which is exactly why this is one shared pure
// function and not four inline `.map`s waiting to drift apart.

import type { StoredMessage } from './transcript-store';

/** The field name, in one place, so a rename cannot half-land. */
const PRIVATE_FIELD = 'plan';

/**
 * One message with `plan` removed from its assistant envelope.
 *
 * Returns the SAME OBJECT REFERENCE — not a copy — whenever there is nothing to
 * strip: a non-assistant message, a message whose content is not JSON (the
 * composed final answer is plain prose, and it is the majority of what is in
 * here), a JSON array or scalar, or an envelope that simply has no `plan`. That
 * identity is the contract this module is tested on: "passes through
 * byte-identical" has to mean the bytes, not something that merely re-serialises
 * to the same meaning.
 */
function stripOne(m: StoredMessage): StoredMessage {
  if (!m || m.role !== 'assistant' || typeof m.content !== 'string') return m;
  // Cheap reject before the parse. An envelope always starts with `{` after
  // trimming, and the common case here is prose.
  const trimmed = m.content.trim();
  if (!trimmed.startsWith('{')) return m;

  let parsed: any;
  try {
    parsed = JSON.parse(m.content);
  } catch {
    // Not JSON — a final answer that happens to open with a brace, or a
    // truncated envelope. Untouched, because guessing at half an object is how
    // a privacy filter turns into a corruption bug.
    return m;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return m;
  if (!Object.prototype.hasOwnProperty.call(parsed, PRIVATE_FIELD)) return m;

  delete parsed[PRIVATE_FIELD];
  return { ...m, content: JSON.stringify(parsed) };
}

/**
 * The client-bound copy of a transcript: every assistant envelope with its
 * `plan` removed, and nothing else changed.
 *
 * Call this at EVERY point a transcript is handed to a browser. Never call it
 * on the copy that is persisted or resumed from — see the module header.
 */
export function stripPrivateReasoning<T extends StoredMessage>(transcript: T[] | null | undefined): T[] {
  if (!Array.isArray(transcript)) return [];
  return transcript.map((m) => stripOne(m as StoredMessage) as T);
}

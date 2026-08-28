// Storage vs. wire split for transcript entries (migration 076).
//
// THE CONSTRAINT THIS EXISTS TO HONOUR. `agent_conversations.transcript` is not
// merely message-shaped — it IS the provider wire format. `ChatMessage`
// (lib/ai/opencode.ts, re-exported by lib/ai/router.ts; identical shape in
// lib/ai/gemini.ts) is declared as exactly `{ role: 'user'|'assistant';
// content: string }` and every provider client serialises that shape straight
// into the request body it sends to OpenCode/Gemini/OpenRouter. Adding an `id`
// field there would ship inside every payload sent to every AI provider —
// polluting model context and risking rejection by a stricter one.
//
// So `id` lives on a STORAGE type, distinct from the WIRE type, and the two
// are converted at the one place that matters: right before a transcript is
// handed to the router (`toWireMessages`, below). `ChatMessage` itself is
// UNCHANGED — this file only ADDS a type that extends it.
//
// StoredMessage is a structural superset of ChatMessage (an optional `id`
// field), so a plain ChatMessage is assignable to a StoredMessage variable in
// either direction without a cast — existing code throughout lib/agent/loop.ts
// that builds `{ role: 'user', content }` literals keeps compiling unchanged.
// The one place that MUST change is every call site that would otherwise
// serialise a StoredMessage array straight into a provider request — that is
// what toWireMessages exists to intercept.

import type { ChatMessage } from '@/lib/ai/router';

/**
 * A transcript entry as stored in `agent_conversations.transcript` (jsonb).
 *
 * `id` is immutable once minted (see `ensureMessageIds`) and is NEVER derived
 * from array position, filename, upload timestamp, or title — none of those
 * are identity. Optional so a plain ChatMessage (no id yet, or a message that
 * predates migration 076 and has not been touched by ensureMessageIds/the
 * backfill) is still a valid StoredMessage.
 */
export interface StoredMessage extends ChatMessage {
  id?: string;
}

/** Mint a new, random, stable message id. Never derived from position — see
 *  the module comment. Exported so the migration's application-side backfill
 *  path (if any) and tests share exactly one id-minting algorithm. */
export function mintMessageId(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Node < 19 fallback (no browser crypto.randomUUID); the repo already
  // targets a Node runtime that has `crypto` as a core module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:crypto').randomUUID();
}

/**
 * Ensure every entry in a transcript carries an id — preserving any id
 * already present, minting only for entries that lack one.
 *
 * THIS is what makes ids survive the write race described in migration 076's
 * header: `transcript` is replaced WHOLE on every save (see saveConversation),
 * so a bulk backfill alone can be clobbered by an in-flight save that reads an
 * un-backfilled row and writes it straight back. Calling this immediately
 * before every write closes that gap: whichever save runs, it mints ids for
 * anything new and carries forward whatever ids the entries already had —
 * including ones the backfill assigned to older rows and ones a PRIOR call to
 * this function assigned earlier in the same turn (e.g. a route minting the
 * new user message's id before the turn runs, purely to bind an attachment to
 * it — see app/api/agent/route.ts).
 *
 * Never mutates its input; returns a new array of new objects, so a caller
 * holding the original reference does not observe ids appearing on it.
 */
export function ensureMessageIds(messages: StoredMessage[]): StoredMessage[] {
  return messages.map((m) => (m && typeof m.id === 'string' && m.id ? m : { ...m, id: mintMessageId() }));
}

/**
 * Strip storage-only fields before a transcript is handed to a provider. This
 * is the ONLY place a StoredMessage[] destined for the router should be
 * converted — see the module comment. Deliberately rebuilds each object with
 * exactly `{ role, content }` rather than deleting `id` off a copy, so an
 * unrelated field added to StoredMessage in the future does not silently leak
 * through here by omission.
 */
export function toWireMessages(messages: StoredMessage[]): ChatMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

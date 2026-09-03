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

/** Default number of most-recent OBSERVATION messages `pruneForWire` leaves
 *  untouched (full text). */
const DEFAULT_KEEP_RECENT_OBSERVATIONS = 2;

/** Default character budget for a reduced (digest) observation body. */
const DEFAULT_DIGEST_CHARS = 2000;

const NUDGE_PREFIX = 'Respond with ONLY one JSON object';
const OBSERVATION_PREFIX = 'OBSERVATION: ';
const TRUNCATION_MARKER = '… [truncated]';

/** Result of trying to collapse an assistant message's content as a
 *  pre-compose JSON envelope. `unparsed` means content is not one of the
 *  `{"action":"tool"|"final",...}` shapes and must be left exactly as-is;
 *  `keep`/`drop` are the two collapsed outcomes. */
type EnvelopeCollapse = { kind: 'unparsed' } | { kind: 'keep'; text: string } | { kind: 'drop' };

/**
 * Turn a route-pass envelope (`{"action":"tool",...}` / `{"action":"final",...}`)
 * into a short one-line narration (`keep`), or `drop` when it is a `final`
 * envelope with nothing worth showing, or `unparsed` when `content` is not
 * one of those envelopes at all (i.e. it should be left exactly as-is).
 */
function collapseEnvelope(content: string): EnvelopeCollapse {
  const trimmed = content.trim();
  if (!trimmed) return { kind: 'unparsed' };
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'unparsed' };
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'unparsed' };
  if (parsed.action === 'tool') {
    const tool = typeof parsed.tool === 'string' && parsed.tool ? parsed.tool : undefined;
    return { kind: 'keep', text: tool ? `[called ${tool}]` : '[called tool]' };
  }
  if (parsed.action === 'final') {
    const msg = parsed.message ?? parsed.answer ?? parsed.text;
    if (typeof msg === 'string' && msg.trim() !== '') return { kind: 'keep', text: msg };
    return { kind: 'drop' }; // nothing worth keeping — drop the message entirely
  }
  return { kind: 'unparsed' };
}

/**
 * Reduce an old OBSERVATION message body to its digest line (see
 * successObservation in lib/agent/loop.ts: the digest is the FIRST line, the
 * raw JSON follows). Returns the full `OBSERVATION: ...` content to keep.
 */
function reduceObservationBody(body: string, digestChars: number): string {
  const newlineIdx = body.indexOf('\n');
  const firstLine = newlineIdx === -1 ? body : body.slice(0, newlineIdx);
  const looksLikeJson = firstLine.startsWith('{') || firstLine.startsWith('[');
  if (firstLine !== '' && !looksLikeJson && firstLine.length < digestChars) {
    return `${OBSERVATION_PREFIX}${firstLine}`;
  }
  const clipped = body.length > digestChars ? `${body.slice(0, digestChars)}${TRUNCATION_MARKER}` : body;
  return `${OBSERVATION_PREFIX}${clipped}`;
}

/**
 * Prune a stored transcript for a ROUTE-PASS provider call — never for the
 * persisted transcript, never for the compose pass (which is grounded on full
 * OBSERVATION text by construction — see compose.ts). This is a separate,
 * opt-in function; `toWireMessages` above is untouched and keeps its exact
 * current behaviour for every other call site.
 *
 * - Nudges (`role: 'user'`, content starting with "Respond with ONLY one JSON
 *   object") are turn-local instructions, meaningless once answered: dropped.
 * - Pre-compose JSON envelopes (`role: 'assistant'`, content that parses as
 *   `{"action":"tool"|"final",...}`) are collapsed to a one-line narration.
 * - All but the most recent `keepRecent` OBSERVATION messages are reduced to
 *   their digest line (or clipped with a truncation marker when there is no
 *   usable digest).
 * - Everything else passes through byte-identical.
 *
 * Never mutates `messages`; order is preserved; dropped entries leave no
 * placeholder.
 */
export function pruneForWire(
  messages: StoredMessage[],
  opts?: { keepRecent?: number; digestChars?: number },
): ChatMessage[] {
  const keepRecent = opts?.keepRecent ?? DEFAULT_KEEP_RECENT_OBSERVATIONS;
  const digestChars = opts?.digestChars ?? DEFAULT_DIGEST_CHARS;

  const observationIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(OBSERVATION_PREFIX)) {
      observationIdxs.push(i);
    }
  }
  const recentObservationIdxs = new Set(observationIdxs.slice(Math.max(0, observationIdxs.length - keepRecent)));

  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const content = m.content;

    if (m.role === 'user' && typeof content === 'string' && content.startsWith(NUDGE_PREFIX)) {
      continue; // nudge — dropped entirely
    }

    if (m.role === 'user' && typeof content === 'string' && content.startsWith(OBSERVATION_PREFIX)) {
      if (recentObservationIdxs.has(i)) {
        out.push({ role: m.role, content });
      } else {
        const body = content.slice(OBSERVATION_PREFIX.length);
        out.push({ role: m.role, content: reduceObservationBody(body, digestChars) });
      }
      continue;
    }

    if (m.role === 'assistant' && typeof content === 'string') {
      const collapsed = collapseEnvelope(content);
      if (collapsed.kind === 'keep') {
        out.push({ role: m.role, content: collapsed.text });
        continue;
      }
      if (collapsed.kind === 'drop') {
        continue; // `final` envelope with nothing worth showing
      }
      // collapsed.kind === 'unparsed' — not a recognised envelope, fall
      // through to byte-identical pass-through below.
    }

    out.push({ role: m.role, content });
  }
  return out;
}

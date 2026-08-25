// Turning a failure into a stable identity.
//
// THE WHOLE POINT. A board fed by production errors is only usable if
// identical failures collapse onto one card. This system has already produced
// a single misconfiguration that generated 9,090 rejected webhooks; nine
// thousand cards is not a backlog, it is the board failing. So every failure
// gets hashed to the SHAPE of the problem rather than its text.
//
// WHAT GETS STRIPPED, and why each one matters. Every value below varies
// between two occurrences of the SAME bug, so leaving any of them in splits
// one ticket into thousands:
//
//   uuids/ids     "lead 41f2… not found" and "lead 9ab3… not found"
//   numbers       row counts, byte sizes, retry attempts, ports
//   timestamps    every single occurrence
//   quoted values the specific email, url or name that triggered it
//   hex/base64    tokens, hashes, request ids
//
// WHAT IS DELIBERATELY KEPT: the route, the status code, and the skeleton of
// the message. Two different bugs on the same route produce different
// skeletons and stay separate — which is the failure mode in the other
// direction, and the more dangerous one, because a ticket that silently
// absorbs an unrelated bug hides it completely.

import { createHash } from 'node:crypto';

/** Reduce a message to its shape. Exported because the normalised form is what
 *  a human should see when asking "why did these two merge?" — an opaque hash
 *  cannot answer that, and a dedup rule nobody can inspect is one nobody can
 *  trust. */
export function normalizeMessage(raw: string): string {
  return (raw || '')
    .toLowerCase()
    // Order matters: uuids before generic hex, or the hex rule eats them in
    // pieces and leaves the dashes behind.
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b[0-9a-f]{16,}\b/g, '<hash>')
    // Quoted or bracketed values: the specific thing that broke, not the break.
    .replace(/"[^"]*"/g, '"<v>"')
    .replace(/'[^']*'/g, "'<v>'")
    // Emails and urls before the number rule, which would otherwise shred them.
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '<email>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b\d{4}-\d{2}-\d{2}[t\s][\d:.]+z?\b/g, '<ts>')
    .replace(/\b\d+(\.\d+)?(ms|s|kb|mb|gb)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    // Long tails are usually stack frames or payload dumps, which vary per
    // occurrence and would defeat the whole exercise.
    .slice(0, 300);
}

export interface FailureShape {
  route?: string | null;
  statusCode?: number | null;
  message: string;
}

/** The dedup key. Short on purpose — it is shown on a card so two tickets can
 *  be compared by eye, and a 64-character hash is not compared by eye. */
export function fingerprintFailure(f: FailureShape): string {
  const skeleton = [
    f.route || 'unknown-route',
    f.statusCode ?? 'no-status',
    normalizeMessage(f.message),
  ].join('|');
  return createHash('sha256').update(skeleton).digest('hex').slice(0, 16);
}

/** A card title someone can scan. Built from the shape rather than the raw
 *  message so the title of a merged ticket describes all its occurrences
 *  rather than whichever one happened to arrive first. */
export function titleFor(f: FailureShape): string {
  const where = f.route ? ` on ${f.route}` : '';
  const code = f.statusCode ? ` (${f.statusCode})` : '';
  const what = normalizeMessage(f.message).slice(0, 90) || 'unlabelled failure';
  return `${what}${where}${code}`;
}

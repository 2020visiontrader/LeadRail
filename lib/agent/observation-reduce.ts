// Reduce an over-large tool result before it enters the transcript.
//
// THE DEFECT THIS FIXES. successObservation() (lib/agent/loop.ts) builds a
// tool result as `${digest}\n${JSON.stringify(result)}`. The digest is
// PREPENDED to the raw payload, never substituted for it, so a capability with
// a perfectly good digest still ships its whole payload into the transcript —
// and every subsequent step of the turn re-sends it.
//
// PRODUCTION EVIDENCE (agent_conversations, project kqimpzbphdogvchqmtos,
// queried 2026-09-02):
//   - The largest stored message is 281,956 chars. It opens with a correct,
//     useful digest — "61 leads returned. By status: 61 new. Includes: Markus
//     Holzinger, Marvin Molenaar, Julieth Quiceno." — followed by ~282k chars
//     of raw lead rows. Two independent conversations each hold one, and the
//     more recent was written by the CURRENT code (conversation updated
//     2026-09-02). This is not a historical artefact.
//   - user-role messages (which is how observations are pushed back) total
//     1,090,511 chars across 271 messages; those two observations alone are
//     563,912 of that — 52% of all transcript content in the project.
//   - Within one 16-step turn, tokens_in grew 2,474 -> 125,937.
//
// It is NOT a broken cap. BUDGET.observationChars resolves to 400,000 chars
// (max(24_000, CONTEXT_WINDOW_CHARS * 0.1) against a declared 1M-token
// window), so 281,956 is legally under the ceiling. Raising or lowering that
// ceiling is a separate question; this module changes the SHAPE of what is
// stored, not the size of the bucket.
//
// WHY REDUCE RATHER THAN DROP. The digest carries the meaning. The payload
// carries the HANDLES: every lead/campaign/post capability takes an id, so an
// agent that can no longer see ids is an agent that can no longer act. That
// failure would be strictly worse than the one being fixed. So ids survive
// exactly — never clipped, never reformatted, never dropped — and a few short
// scalar fields survive with them so a row is still recognisable.
//
// WHY NEVER A MID-JSON TRUNCATION. The existing per-observation cap cuts with
// `s.slice(0, limit)`, which is visible in production as a 24,026-char message
// ending mid-object. A half-object is worse than an honest summary: the model
// may parse it as complete. Everything this module emits is well-formed JSON
// plus a separate prose note.
//
// This module is PURE and has no imports: it is drivable from a test without
// the DB, the capability registry or either agent loop — the same reason
// lib/agent/reads.ts and lib/agent/json-envelope.ts exist.

/** Size at which a result carrying a digest stops being sent whole.
 *
 *  From the production distribution above: of 271 stored observations only 39
 *  exceed 3,000 chars, and among those there is a clean gap. The largest
 *  results that are genuinely "an answer the model reasons over whole" are
 *  8,456 chars (13 finished outreach drafts) and 8,026 (a 5-lead listing). The
 *  smallest result that is purely a bulk row dump is 18,843 (sourceLeads
 *  candidates); the rest are 24,026 and 281,956. 12,000 sits inside that gap:
 *  above every observed reason-over-it-whole result, below every observed dump.
 *  Nothing at or under it changes shape at all. */
export const REDUCE_THRESHOLD_WITH_DIGEST = 12_000;

/** The same size for a result with NO digest.
 *
 *  Deliberately three times higher, because the two cases are not symmetric.
 *  With a digest, the meaning of the result has already been stated in prose
 *  and the payload is only needed for handles — reducing it loses little. With
 *  no digest the raw payload is the ONLY signal the model has, so reducing it
 *  early would delete the result's meaning outright with nothing to replace
 *  it. It is still bounded, because an unbounded dump is what this module
 *  exists to stop; 36,000 is simply set above every no-digest observation ever
 *  recorded in this project (the largest is 19,133) so it fires only on a
 *  payload that is certainly a bulk dump.
 *
 *  The better fix for a capability that regularly lands here is to give it a
 *  digest — then it gets the tighter threshold and keeps its meaning. */
export const REDUCE_THRESHOLD_NO_DIGEST = 36_000;

/** Non-identifier scalar fields kept per row.
 *
 *  Four, for two reasons. It is what the digests themselves already sample to
 *  make a row recognisable (name / company / email / status — see
 *  `samples()` in lib/capabilities/types.ts), and on the real 61-lead payload
 *  it produces a reduced form of a few thousand characters, comfortably under
 *  REDUCE_THRESHOLD_WITH_DIGEST, so the reduced form never needs reducing. */
export const MAX_ROW_FIELDS = 4;

/** Longest string kept as a "short scalar". A value longer than this is prose
 *  (a body, a bio, a summary), which is exactly the bulk being removed. */
const MAX_SCALAR_CHARS = 64;

/** Arrays of plain scalars are kept only when they are short enough to be a
 *  label set (tags, statuses) rather than a payload of their own. */
const MAX_SCALAR_ARRAY = 8;

/** Keys preferred when choosing the MAX_ROW_FIELDS survivors — the generic
 *  identity/state words that make a row recognisable to a human or a model.
 *  Not tool-specific: a key absent from a row is simply skipped, and any row
 *  whose keys are all unlisted still gets its first four short scalars. */
//  Ordering note: `status`/`stage` rank above `email`/`company` because the
//  digests themselves report a status tally ("By status: 61 new"), and a
//  per-row tally the model cannot check against the rows is a claim it has to
//  take on trust.
const PREFERRED_KEYS = [
  'name', 'title', 'status', 'stage', 'state', 'email', 'subject', 'company',
  'platform', 'type', 'url', 'created_at',
];

/** True for a key that names a handle the model needs in order to act on the
 *  row. Covers `id`, snake_case `*_id`, camelCase `*Id`, and the few other
 *  spellings this codebase uses for the same thing. */
function isIdKey(k: string): boolean {
  return (
    k === 'id' ||
    /_id$/i.test(k) ||
    /[a-z0-9]Id$/.test(k) ||
    k === 'uuid' || k === 'slug' || k === 'externalId'
  );
}

function isPlainObject(v: any): boolean {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isShortScalar(v: any): boolean {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return true;
  return typeof v === 'string' && v.length <= MAX_SCALAR_CHARS;
}

function isObjectArray(v: any): v is any[] {
  return Array.isArray(v) && v.length > 0 && v.every(isPlainObject);
}

/** One row, reduced: every id field EXACTLY as it was, then up to
 *  MAX_ROW_FIELDS short scalars, preferred keys first and otherwise in the
 *  row's own key order. Nested objects, arrays and long strings are dropped —
 *  they are the bulk, and the digest already speaks for them. */
function reduceRow(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  const keys = Object.keys(row);
  // Ids first, and unconditionally: an id is preserved whatever its type or
  // length. Truncating or dropping one turns a working agent into one that
  // cannot act on the rows it was just shown.
  for (const k of keys) if (isIdKey(k)) out[k] = row[k];
  const rest = keys.filter((k) => !isIdKey(k) && isShortScalar(row[k]));
  const ordered = [
    ...PREFERRED_KEYS.filter((k) => rest.includes(k)),
    ...rest.filter((k) => !PREFERRED_KEYS.includes(k)),
  ];
  for (const k of ordered.slice(0, MAX_ROW_FIELDS)) out[k] = row[k];
  return out;
}

/** Reduce every array-of-objects reachable at the top level. Returns the
 *  reduced value and how many rows it covered; rows === 0 means there was
 *  nothing of this shape to reduce, and the caller leaves the payload alone
 *  rather than inventing some other kind of shrinkage. */
function reduceValue(value: any): { value: any; rows: number } {
  if (isObjectArray(value)) {
    return { value: value.map(reduceRow), rows: value.length };
  }
  if (isPlainObject(value)) {
    const out: Record<string, any> = {};
    let rows = 0;
    for (const [k, v] of Object.entries(value)) {
      if (isObjectArray(v)) {
        out[k] = v.map(reduceRow);
        rows += v.length;
      } else if (isShortScalar(v)) {
        // Kept verbatim: these are the wrapper's own facts (`total`, `status`,
        // a cursor) and they are small and load-bearing.
        out[k] = v;
      } else if (Array.isArray(v) && v.length <= MAX_SCALAR_ARRAY && v.every(isShortScalar)) {
        out[k] = v;
      } else if (isPlainObject(v)) {
        out[k] = reduceRow(v as Record<string, any>);
      }
      // Anything else (a long string, a long scalar array, an array of mixed
      // shapes) is dropped: it is bulk, and the note says the payload was
      // reduced so nothing is being passed off as complete.
    }
    return { value: out, rows };
  }
  return { value, rows: 0 };
}

export interface ReducedPayload {
  /** The payload to put in the observation. Byte-identical to `raw` whenever
   *  no reduction happened. Always well-formed JSON when `note` is set. */
  raw: string;
  /** A one-line prose note, or null when nothing was reduced. The caller
   *  appends it to the DIGEST LINE rather than to the JSON, so the payload
   *  stays parseable — lib/agent/observation-render.ts splits an observation
   *  at the first newline and parses everything after it. */
  note: string | null;
}

/**
 * Decide what a successful tool result contributes to the transcript.
 *
 * `raw` is `JSON.stringify(result)` as the caller already computed it, so a
 * pass-through is guaranteed byte-identical rather than re-serialised.
 * `hasDigest` selects the threshold (see the two constants above).
 *
 * Never throws: any unexpected shape returns the original payload unchanged.
 */
export function reduceObservationPayload(
  result: any,
  raw: string | undefined,
  hasDigest: boolean,
): ReducedPayload {
  // `JSON.stringify(undefined)` is undefined. Preserve whatever the caller had.
  if (typeof raw !== 'string') return { raw: raw as any, note: null };
  const threshold = hasDigest ? REDUCE_THRESHOLD_WITH_DIGEST : REDUCE_THRESHOLD_NO_DIGEST;
  if (raw.length <= threshold) return { raw, note: null };
  try {
    const { value, rows } = reduceValue(result);
    if (rows === 0) return { raw, note: null };
    const reduced = JSON.stringify(value);
    // A "reduction" that did not reduce anything is not worth the note, and
    // must never make the observation larger than doing nothing would have.
    if (typeof reduced !== 'string' || reduced.length >= raw.length) return { raw, note: null };
    return {
      raw: reduced,
      note: `… reduced: ${rows} row${rows === 1 ? '' : 's'}, ids and key fields only (full payload omitted).`,
    };
  } catch {
    return { raw, note: null };
  }
}

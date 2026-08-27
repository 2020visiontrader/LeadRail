// Parsing the one JSON envelope a model turn is supposed to emit.
//
// A separate module because it is a PURE function with no dependencies — which
// means it can be tested directly against the real responses that broke it,
// instead of through a loop that needs the database, the logger and the whole
// capability registry standing up first. The bugs below survived precisely
// because nothing tested them in isolation.
//
// WHAT IT COST. Production turns ran between four and eighteen minutes burning
// retries on responses that were one character from valid, then ended on
// "I gathered the details but had trouble summarizing." The rawPreview logging
// added earlier is what surfaced the actual payloads; every case in
// tests/agent-json-extract.test.ts is one of them, verbatim.

/**
 * Yield each top-level `{...}` in `raw`, in order, string-aware.
 *
 * THE BUG THIS REPLACES. The old scan was `raw.match(/\{[\s\S]*\}/)` — GREEDY,
 * so it spanned from the FIRST `{` to the LAST `}`. When a model emitted two
 * envelopes in one response, which it does, that match covered both objects
 * plus the space between them and could never be valid JSON. A response
 * containing a perfectly good first envelope was thrown away whole.
 *
 * String-aware because a `}` inside a message ("...that's it}") must not close
 * the object, and an escaped quote must not end the string.
 */
export function* balancedObjects(raw: string): Generator<string> {
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) { yield raw.slice(start, i + 1); start = -1; }
      if (depth < 0) depth = 0;
    }
  }
}

/**
 * Repair the near-misses a model actually produces.
 *
 * Observed in production, not imagined: `"args":{limit: 200}` — a JavaScript
 * object literal with an unquoted key. That is one character from valid and the
 * intent is unambiguous, yet it cost a whole step: the turn retried, burned its
 * budget, and ended on "I gathered the details but had trouble summarizing"
 * after eighteen minutes.
 *
 * Deliberately conservative. It only quotes bare identifier keys and drops
 * trailing commas, both OUTSIDE strings — it does not try to fix truncation
 * (salvageFinalMessage owns that) and it never rewrites a value. A repair that
 * guesses at content would turn a parse failure into a wrong answer, which is
 * worse.
 */
export function repairJson(text: string): string {
  let out = '';
  let inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    // A trailing comma before a closer.
    if (c === ',') {
      const next = text.slice(i + 1).match(/^\s*([}\]])/);
      if (next) continue;
      out += c;
      continue;
    }
    // A bare identifier immediately followed by a colon is an unquoted key.
    if (/[A-Za-z_$]/.test(c)) {
      const m = text.slice(i).match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/);
      if (m) { out += `"${m[1]}":`; i += m[0].length - 1; continue; }
    }
    out += c;
  }
  return out;
}

/**
 * The first usable JSON envelope in a model response.
 *
 * Tries each balanced object in order, strictly first and then repaired. Order
 * matters: a strictly-valid later object should not win over a repairable
 * earlier one, because the FIRST envelope is the one the model meant to act on
 * — the rest are it running ahead of itself.
 */
export function extractJson(raw: string): any | null {
  for (const candidate of balancedObjects(raw)) {
    try { return JSON.parse(candidate); } catch { /* try repairing it */ }
    try { return JSON.parse(repairJson(candidate)); } catch { /* next object */ }
  }
  return null;
}
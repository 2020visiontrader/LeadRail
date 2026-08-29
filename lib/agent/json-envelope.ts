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

/**
 * Recover usable prose from the FORCED-FINAL call specifically — the very
 * last call of a turn, whose entire job is to hand the user plain language.
 * Unlike the step loop (which MUST get a `{"action":...}` envelope back
 * because it has more steps to decide between), a forced-final response that
 * isn't valid `{"action":"final",...}` JSON is not automatically a failure:
 * the model may simply have answered in plain text instead of wrapping it,
 * and PRODUCTION INCIDENT (app_logs, four occurrences in 3 hours) shows that
 * answer being thrown away and the user told the turn failed even though the
 * model wrote a good reply.
 *
 * Returns the prose to show the user, or null if there is none to salvage
 * (caller falls through to buildSalvageMessage / the apology).
 *
 * THE CRUX: prose vs. a machine envelope are not the same thing and must not
 * be confused. `{"action":"tool",...}` or any other non-`final` envelope is
 * NOT prose — it is the model still speaking JSON, just the wrong shape, and
 * stringifying it into a reply would hand the user a JSON blob. This
 * function whole-response-rejects (returns null) the instant it finds ANY
 * complete, parseable object with a top-level `action` key, anywhere in the
 * response — never partially uses text around it.
 */
export function extractForcedFinalProse(raw: string): string | null {
  if (!raw) return null;
  // Strip code fences first — ```json ... ``` or ``` ... ``` — whether they
  // wrap the whole response or just a leading/trailing chunk of it, so a
  // fence is never left dangling in what the user reads.
  let text = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  if (!text) return null;

  // Reject the whole response if it contains a complete, parseable object
  // with an `action` key anywhere — that is the model still emitting the
  // envelope protocol (just not the `final` shape forced-final asked for:
  // e.g. {"action":"tool",...}), never prose, regardless of what text
  // surrounds it.
  for (const candidate of balancedObjects(text)) {
    let obj: any = null;
    try { obj = JSON.parse(candidate); } catch { /* try repairing */ }
    if (obj === null) {
      try { obj = JSON.parse(repairJson(candidate)); } catch { /* not an object */ }
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && 'action' in obj) return null;
  }

  // A leading brace that never closes (depth never returns to 0) is a
  // dangling envelope fragment the model abandoned mid-write — e.g.
  // `{"action": "fin\nActually, here's what I found: ...` — balancedObjects
  // never yields it (it only yields BALANCED objects), so it survives the
  // check above and must be stripped separately. Drop the fragment's own
  // line and keep whatever text sits before and after it — that surrounding
  // text is the real prose the model went on to write.
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0, inString = false, escaped = false, closed = false;
    for (let i = firstBrace; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { closed = true; break; } }
    }
    if (!closed) {
      const nl = text.indexOf('\n', firstBrace);
      if (nl === -1) {
        // No prose follows the dangling fragment on a later line — nothing
        // left to salvage but whatever preceded it.
        text = text.slice(0, firstBrace).trim();
      } else {
        text = (text.slice(0, firstBrace) + text.slice(nl + 1)).trim();
      }
    }
  }
  if (!text) return null;

  // Substantive-length floor. A couple of stray characters left after
  // stripping fences/fragments ("ok", ".", "") is not an answer — handing it
  // to the user as if it were one is worse than falling through to salvage
  // or the honest apology. 20 non-whitespace characters is roughly the
  // length of the shortest real sentence a model would write as an answer
  // ("I couldn't find that." is 21) — short enough not to reject a terse but
  // genuine reply, long enough to filter out noise.
  if (text.replace(/\s+/g, '').length < 20) return null;

  return text;
}
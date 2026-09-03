// Comprehension pass — understand the request and its material BEFORE any
// routing or fan-out decision touches either one.
//
// THE PRODUCTION TRACE THAT MOTIVATED THIS. A user attached a 34,649-character
// meeting transcript and asked "analyse this transcript". The trace read
// "Ada is checking the numbers… Nia is reviewing spend and channels…" — both
// wrong; the transcript was a sales/investor pitch call, not a budget review.
// Root cause: routing ran on `attachmentDigest()`, a HEAD SLICE of the
// attached-document block (its first ROUTING_DIGEST_CHARS characters). On the
// real file that slice was 3.46% of the document, roughly 600 of whose 1,200
// characters were the safety preamble every attachment block opens with — so
// the router actually saw ~570 characters of the caller's opening small talk
// ("we are equity agency… over 20 million kind of Euros in revenue…"),
// money-and-agency vocabulary that is exactly why a numbers persona and a
// spend persona got picked. Worse, the trace's "Reading the attached
// material…" step fired immediately before routing with NO MODEL CALL in
// between — a label on a string slice, resolving instantly because there was
// nothing to wait for. It advertised comprehension that never happened.
//
// THE FIX. One cheap model call, run over the material (never a head slice —
// see sampleAcrossDocument below), producing a structured Understanding that
// routing scores against instead of raw text. A failed or unparseable call
// returns null and the caller falls back to today's behaviour — comprehension
// must never be a new way for a turn to fail.
//
// Its own module for the same reason lib/agent/json-envelope.ts and
// lib/agent/stream-outcome.ts are their own modules (see CLAUDE.md's "extract
// for testability when the defect is in the path, not the parts"): this can
// be driven directly with a mocked generateChat, without standing up the DB,
// the tool registry, or either agent loop.

import { generateChat } from '@/lib/ai/router';
import { extractJson } from './json-envelope';

export interface Understanding {
  /** What the user actually wants, restated in the comprehension pass's own
   *  words — not copied verbatim, so a garbled or truncated dictation still
   *  yields something routable. */
  ask: string;
  askType: 'analyse' | 'build' | 'decide' | 'find' | 'other';
  material?: {
    /** e.g. "meeting transcript", "sales report", "spreadsheet of leads". */
    kind: string;
    /** What the material is actually ABOUT — the whole point of this pass. */
    subject: string;
    participants?: string[];
    /** e.g. "raw ASR with heavy transcription errors". Optional. */
    quality?: string;
    /** The substance, drawn from ACROSS the material — never just its
     *  opening, which is the entire defect this module exists to fix. */
    keyPoints: string[];
  };
  /** What a useful answer looks like for this request. */
  outputShape: string;
  /** CAPABILITIES the work requires (e.g. "financial analysis",
   *  "copywriting") — never persona or team-member names. This pass has no
   *  idea who is on the team; naming a persona here would let routing be
   *  short-circuited by a hallucinated name instead of scored properly. */
  needs: string[];
}

const ASK_TYPES = new Set(['analyse', 'build', 'decide', 'find', 'other']);

// Cheap, fast tier — the same discipline the ROUTE pass in lib/agent/loop.ts
// already applies (see AGENT_OPENCODE_MODEL there): the reasoning that
// decides what happens next should not wait on the tier reserved for writing
// the user-facing answer. deepseek-v4-flash's enabled context window
// (1,048,576 tokens on OpenRouter) is what makes a single-pass read of a
// 35,000-character transcript possible at all — no chunk/summarize/combine
// pipeline needed for material of that size.
const COMPREHENSION_MODEL = 'deepseek-v4-flash';

// Ceiling on what the comprehension call itself reads out of the attached
// material. NOT the same number as ROUTING_DIGEST_CHARS (1,200, a head slice)
// that this pass replaces as a routing input — this is an order of magnitude
// larger, and unlike that digest it is never just the head (see
// sampleAcrossDocument). It exists so a genuinely enormous attachment (a
// dumped codebase, a full book) still bounds the comprehension call's own
// prompt size rather than turning "read the document" into "read the whole
// library" — deepseek-v4-flash's window is large but not infinite, and the
// comprehension call still has to leave room for its own system prompt and
// answer.
const COMPREHENSION_CHAR_BUDGET = Number(process.env.COMPREHENSION_CONTEXT_CHARS) || 120_000;

/**
 * Bounded excerpt of `material` for the comprehension call.
 *
 * NEVER a head slice — that is the entire defect being fixed here. Documents
 * open with throat-clearing (a caller's small talk, a title page, an agenda);
 * the substance a comprehension pass needs to name correctly is distributed
 * across the whole thing. When `material` already fits `budget` it is used
 * whole. When it doesn't, this samples evenly spaced windows from the START,
 * MIDDLE, and END of the document and concatenates them — cheap, one pass,
 * and unlike a head slice it cannot land entirely inside the opening
 * pleasantries of a transcript no matter how long the transcript is.
 */
export function sampleAcrossDocument(material: string, budget: number): string {
  if (material.length <= budget) return material;
  const SEGMENTS = 5;
  const segLen = Math.floor(budget / SEGMENTS);
  if (segLen <= 0) return material.slice(0, Math.max(0, budget));
  const parts: string[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const start = Math.floor((material.length - segLen) * (i / (SEGMENTS - 1)));
    parts.push(material.slice(start, start + segLen));
  }
  return parts.join('\n\n[…material continues…]\n\n');
}

/**
 * One cheap model call producing a structured Understanding, or null on any
 * failure — a bad response, an unparseable one, or a thrown error. NEVER
 * throws: comprehension is a pass the caller can always safely skip, and a
 * failed comprehension must fall back to the caller's pre-comprehension
 * behaviour rather than failing the turn.
 *
 * `material` is the FULL attached-document text (unbounded) — this function
 * owns bounding it (see sampleAcrossDocument), so callers should not
 * pre-truncate it themselves the way the old attachmentDigest() head slice
 * did.
 */
export async function comprehend(input: {
  message: string;
  material?: string;
  accountId?: string;
  /** Absolute epoch-ms deadline for the turn this pass runs in. Optional/
   *  additive: a caller that omits it gets byte-identical (unbounded)
   *  behaviour. This pass runs while a user is waiting on a turn, so it must
   *  carry THAT turn's deadline — never an invented one. */
  deadlineAt?: number;
}): Promise<Understanding | null> {
  if (!input.message?.trim() && !input.material?.trim()) return null;
  try {
    const excerpt = input.material ? sampleAcrossDocument(input.material, COMPREHENSION_CHAR_BUDGET) : '';
    const system = [
      'You are a comprehension pass that runs BEFORE any routing or delegation decision — your job is to understand the request, nothing else.',
      'Read the request and, if present, the attached material in full — including material past its opening — and reply with exactly ONE JSON object, nothing else, no markdown fences.',
      'Shape: {"ask":"...","askType":"analyse|build|decide|find|other","material":{"kind":"...","subject":"...","participants":["..."],"quality":"...","keyPoints":["...","..."]},"outputShape":"...","needs":["...","..."]}',
      'Omit "material" (or set it null) when nothing was attached.',
      '"subject" and "keyPoints" must reflect the material AS A WHOLE, never just its opening lines — an opening is often small talk or throat-clearing, not the substance.',
      '"needs" names the CAPABILITIES this work requires (e.g. "financial analysis", "copywriting", "media/channel planning") — never a person or team-member name; you do not know who is on the team.',
    ].join('\n');
    const raw = await generateChat({
      system,
      messages: [{
        role: 'user',
        content: input.material
          ? `Request: ${input.message || '(none)'}\n\nAttached material:\n${excerpt}`
          : `Request: ${input.message || '(none)'}`,
      }],
      // 0, not a small non-zero value — this pass is a classification/
      // extraction step whose output is consumed as structured data
      // (parseUnderstanding), never as prose a reader sees, so there is no
      // upside to sampling here. Non-zero temperature was measured causing
      // real nondeterminism: an identical request shape produced a
      // different "needs" list on different runs, which is what made
      // production roster drift (Ada/Milo/Ezra one run, Ada/Milo/Vale the
      // next — see the header comment) impossible to reproduce. This pass
      // never names a persona itself (see the `needs` doc above), so it is
      // only ONE source of that drift, not the whole of it — whatever maps
      // these capabilities to actual persona names downstream is a separate
      // question; see lib/agent/loop.ts's fan-out detection for whether
      // THAT mapping is deterministic. Do not raise this back up "for
      // variety" — that is the exact tuning this comment exists to prevent.
      temperature: 0,
      maxOutputCeiling: 2000,
      preferTier: 'fast',
      model: COMPREHENSION_MODEL,
      accountId: input.accountId,
      deadlineAt: input.deadlineAt,
    });
    return parseUnderstanding(raw);
  } catch {
    return null;
  }
}

/** Defensive parse of the model's response into an Understanding, reusing
 *  balancedObjects/repairJson (via extractJson) rather than a second JSON
 *  parser, per the house instruction to reuse lib/agent/json-envelope.ts
 *  where it fits. Exported so parsing can be tested directly against
 *  near-miss model output without a live call. */
export function parseUnderstanding(raw: string): Understanding | null {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.ask !== 'string' || !parsed.ask.trim()) return null;

  const needs = Array.isArray(parsed.needs) ? parsed.needs.map(String).filter(Boolean) : [];

  let material: Understanding['material'];
  if (parsed.material && typeof parsed.material === 'object') {
    material = {
      kind: String(parsed.material.kind || 'document'),
      subject: String(parsed.material.subject || ''),
      participants: Array.isArray(parsed.material.participants)
        ? parsed.material.participants.map(String).filter(Boolean)
        : undefined,
      quality: parsed.material.quality ? String(parsed.material.quality) : undefined,
      keyPoints: Array.isArray(parsed.material.keyPoints) ? parsed.material.keyPoints.map(String).filter(Boolean) : [],
    };
  }

  return {
    ask: String(parsed.ask),
    askType: ASK_TYPES.has(parsed.askType) ? parsed.askType : 'other',
    material,
    outputShape: String(parsed.outputShape || ''),
    needs,
  };
}

/** Compact block folded into a fan-out delegate's context alongside its
 *  bounded raw-material slice (see delegateContext in lib/agent/loop.ts) — a
 *  delegate gets the UNDERSTANDING plus a slice, not N verbatim copies of the
 *  whole document. Deliberately terse: this is grounding, not a substitute
 *  for the material itself. */
export function formatUnderstandingBlock(understanding: Understanding): string {
  const lines = [
    'TASK UNDERSTANDING (from a comprehension pass over the full material):',
    `Ask: ${understanding.ask}`,
  ];
  if (understanding.material?.subject) lines.push(`Subject: ${understanding.material.subject}`);
  if (understanding.material?.keyPoints?.length) {
    lines.push('Key points:');
    for (const kp of understanding.material.keyPoints) lines.push(`- ${kp}`);
  }
  if (understanding.outputShape) lines.push(`Useful output looks like: ${understanding.outputShape}`);
  return lines.join('\n');
}

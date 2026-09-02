// scripts/lib/notice.ts — the ONE place either harvest script touches the
// root NOTICE file.
//
// THE BUG THIS CLOSES (BACKLOG 5c, residual). scripts/harvest-skills.ts used
// to regenerate NOTICE wholesale with writeFileSync, and
// scripts/harvest-personas.ts's attribution for its two sources lived only in
// that same wholesale file — nothing scoped either script's write to its own
// content. Re-running harvest-skills.ts after harvest-personas.ts had added
// its persona paragraphs silently dropped them; there was no way to run both
// in either order and keep both sets of credits.
//
// THE FIX. NOTICE is composed from named, delimited SECTIONS, each owned by
// exactly one script: harvest-skills.ts owns 'SKILLS', harvest-personas.ts
// owns 'PERSONAS'. writeNoticeSection(name, body) reads whatever is
// currently on disk, replaces ONLY the named section's body between its own
// markers, leaves every other section's markers and body untouched (even a
// section that has NEVER been written on this machine — an absent section is
// just an empty body, not an error), and writes the sections back in a FIXED
// order (SKILLS then PERSONAS) regardless of which script ran, or which ran
// most recently. That fixed order is what makes the two scripts commute: run
// A then B, or B then A, and the byte-for-byte output is identical, because
// neither script's write depends on what the other last did — only on what
// section it owns.
//
// The preamble (copyright line + the paragraph explaining the split) is
// static and reasserted on every write by whichever script runs — cheap
// (it's four lines) and means the file is never left without it even on a
// machine where only one of the two scripts has ever run.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NOTICE_PATH = join(__dirname, '..', '..', 'NOTICE');

const PREAMBLE = `LeadRail
Copyright (c) LeadRail

This product includes CONTENT — never upstream source code — derived from the
open-source projects attributed in the sections below. Each section is
generated and owned by exactly one script, named in its own heading:
scripts/harvest-skills.ts owns "Skill content" (-> lib/skills/harvested.ts),
scripts/harvest-personas.ts owns "Persona-template content"
(-> lib/agent/harvested-personas.ts). Re-running either script regenerates
ONLY its own section below (see scripts/lib/notice.ts) — the other section's
attribution survives regardless of run order, including a first run of either
script alone.`;

export type NoticeSection = 'SKILLS' | 'PERSONAS';

// Fixed file order — NOT the order scripts happen to run in. This is what
// makes writeNoticeSection commute across run order; see the module header.
const SECTION_ORDER: NoticeSection[] = ['SKILLS', 'PERSONAS'];

function sectionMarkers(name: NoticeSection): { begin: string; end: string } {
  return { begin: `<!-- NOTICE:${name}:BEGIN -->`, end: `<!-- NOTICE:${name}:END -->` };
}

/** Every section's current body, keyed by section name. A section that has
 *  never been written (markers absent, or the file doesn't exist yet) reads
 *  as an empty string — never an error, so the very first harvest run on a
 *  fresh checkout works with nothing special. */
function readCurrentSections(path: string): Record<NoticeSection, string> {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const out = {} as Record<NoticeSection, string>;
  for (const name of SECTION_ORDER) {
    const { begin, end } = sectionMarkers(name);
    const i = existing.indexOf(begin);
    const j = existing.indexOf(end);
    out[name] = (i !== -1 && j !== -1 && j > i) ? existing.slice(i + begin.length, j).trim() : '';
  }
  return out;
}

/**
 * Replace ONE section's body and rewrite NOTICE, preserving every other
 * section exactly as it currently stands. `body` is the section's full text
 * (heading rule, attribution paragraph(s), source table, etc.) with no outer
 * markers — this function owns the markers and the preamble.
 *
 * `path` defaults to the real root NOTICE and is overridable only so
 * tests/notice-compose.test.ts can exercise this against a scratch file
 * instead of the repo's own NOTICE — neither harvest script ever passes it.
 */
export function writeNoticeSection(name: NoticeSection, body: string, path: string = NOTICE_PATH): void {
  const sections = readCurrentSections(path);
  sections[name] = body.trim();
  const parts = [PREAMBLE];
  for (const s of SECTION_ORDER) {
    const { begin, end } = sectionMarkers(s);
    // An empty, never-yet-written section still gets its markers emitted —
    // so a later run of the OTHER script can find them and fill them in,
    // and so it's visible in the file that the section is expected but not
    // yet populated on this machine, not silently missing.
    parts.push(`${begin}\n${sections[s]}\n${end}`);
  }
  writeFileSync(path, parts.join('\n\n') + '\n', 'utf8');
}

export { NOTICE_PATH };

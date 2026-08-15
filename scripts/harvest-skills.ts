// scripts/harvest-skills.ts
//
// One-shot, offline import: walk the adclaw OSS repo's SKILL.md files and emit
// a typed lib/skills/harvested.ts array. This is a PURE, SYNCHRONOUS, LOCAL
// FILE-PARSING script — no LLM/AI calls, no network, no MCP, no subprocesses.
// The "quality/security scan" below is regex/string heuristics ONLY. A single
// malformed SKILL.md is skipped, never fatal — the whole run must finish in
// well under 15s.
//
// Run once with: npx tsx scripts/harvest-skills.ts
// (Re-run any time the source repo changes; output is fully regenerated.)

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_ROOT = '/home/.z/workspaces/con_rf0cG0dud6GVzG4C/oss-repos/adclaw';
const SKILLS_ROOT = join(SOURCE_ROOT, 'src/adclaw/agents/skills');
const OUTPUT_FILE = join(__dirname, '..', 'lib', 'skills', 'harvested.ts');
const MIN_BODY_LENGTH = 80;

// ---------------------------------------------------------------------------
// License gate — abort the whole import if the source isn't Apache/MIT.
// ---------------------------------------------------------------------------
function verifyLicense(): string {
  const licensePath = join(SOURCE_ROOT, 'LICENSE');
  let text: string;
  try {
    text = readFileSync(licensePath, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read LICENSE at ${licensePath}: ${(e as Error).message}`);
  }
  const head = text.slice(0, 2000);
  if (/Apache License[\s\S]*Version 2\.0/i.test(head)) return 'Apache-2.0';
  if (/MIT License/i.test(head)) return 'MIT';
  throw new Error('Source LICENSE is not Apache-2.0 or MIT — aborting import (see printed head above).');
}

// ---------------------------------------------------------------------------
// Category mapping — best-effort keyword match on the skill directory name.
// Mirrors the SkillCategory union in lib/skills/registry.ts, but harvested
// skills are a superset, so category here is a free-text label rather than a
// TS union member (kept broad: seo, ads, marketing, content, analytics, dev,
// social, other).
// ---------------------------------------------------------------------------
function mapCategory(dirName: string): string {
  const d = dirName.toLowerCase();
  if (d.startsWith('seo')) return 'seo';
  if (d.startsWith('ads') || d.includes('google-ads')) return 'ads';
  if (d.startsWith('marketing')) return 'marketing';
  if (d.includes('social') || d.includes('twitter') || d.includes('instagram') || d.includes('reddit') || d.includes('tiktok')) return 'social';
  if (d.includes('email') || d.includes('himalaya') || d.includes('dingtalk')) return 'email';
  if (d.includes('analytics') || d.includes('ga4') || d.includes('gsc')) return 'analytics';
  if (d.includes('content') || d.includes('citedy') || d.includes('video') || d.includes('image') || d.includes('deck') || d.includes('pptx') || d.includes('docx') || d.includes('xlsx') || d.includes('pdf')) return 'content';
  if (d.includes('browser') || d.includes('playwright') || d.includes('crawl') || d.includes('firecrawl') || d.includes('sitefetch') || d.includes('camoufox')) return 'dev-tooling';
  if (d.includes('cron') || d.includes('agenthub') || d.includes('skill-creator') || d.includes('self-setup')) return 'ops';
  return 'other';
}

// ---------------------------------------------------------------------------
// Minimal YAML frontmatter parser — only needs flat `key: value` pairs plus
// quoted-string values (the two shapes actually used across the ~120
// SKILL.md files sampled: `name: foo` and `description: "..."`). Not a
// general YAML parser by design — this is a bounded, local, synchronous
// heuristic, not a dependency.
// ---------------------------------------------------------------------------
function parseFrontmatter(raw: string): { attrs: Record<string, string>; body: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const [, fmBlock, body] = m;
  const attrs: Record<string, string> = {};
  const lines = fmBlock.split(/\r?\n/);
  let currentKey: string | null = null;
  for (const line of lines) {
    // top-level `key: value` (skip nested/indented lines like `metadata:` blocks)
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (kv && !/^\s/.test(line)) {
      const [, key, rawValue] = kv;
      currentKey = key;
      let value = rawValue.trim();
      // Strip a single layer of matching quotes.
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      attrs[key] = value;
    } else {
      currentKey = null;
    }
  }
  return { attrs, body };
}

// ---------------------------------------------------------------------------
// Quality/security scan — REGEX/STRING HEURISTICS ONLY. Flags a skill for
// skip if it looks like it embeds a live secret or destructive shell command,
// or is too short to be a real skill body.
// ---------------------------------------------------------------------------
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'openai-style-secret-key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'literal-api-key-assignment', re: /api[_-]?key\s*[:=]\s*["'][^"'\s]{8,}["']/i },
  { name: 'literal-password-assignment', re: /password\s*[:=]\s*["'][^"'\s]{4,}["']/i },
];
const DESTRUCTIVE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'rm-rf-root', re: /rm\s+-rf\s+\/(?:\s|$)/ },
  { name: 'curl-pipe-shell', re: /curl[^\n]*\|\s*(sudo\s+)?sh\b/ },
  { name: 'wget-pipe-shell', re: /wget[^\n]*\|\s*(sudo\s+)?sh\b/ },
];

function scanQuality(body: string): string[] {
  const flags: string[] = [];
  for (const p of SECRET_PATTERNS) if (p.re.test(body)) flags.push(`secret:${p.name}`);
  for (const p of DESTRUCTIVE_PATTERNS) if (p.re.test(body)) flags.push(`destructive:${p.name}`);
  if (body.trim().length < MIN_BODY_LENGTH) flags.push('too-short');
  return flags;
}

function slugify(name: string, dirName: string): string {
  const base = (name || dirName).toLowerCase().trim();
  return base
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || dirName.toLowerCase();
}

// ---------------------------------------------------------------------------
// Types (also exported for lib/skills/harvested.ts consumers)
// ---------------------------------------------------------------------------
interface HarvestedSkillRaw {
  slug: string;
  name: string;
  description: string;
  category: string;
  instructions: string;
  source: string;
  license: string;
  inspiredBy: string;
}

function main() {
  const startedAt = Date.now();
  const license = verifyLicense();
  console.log(`[harvest-skills] source LICENSE verified: ${license}`);

  let dirs: string[] = [];
  try {
    dirs = readdirSync(SKILLS_ROOT).filter((name) => {
      try {
        return statSync(join(SKILLS_ROOT, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch (e) {
    throw new Error(`Cannot read skills dir ${SKILLS_ROOT}: ${(e as Error).message}`);
  }

  let found = 0;
  let imported = 0;
  const skipped: { dir: string; reason: string }[] = [];
  const seenSlugs = new Set<string>();
  const results: HarvestedSkillRaw[] = [];

  for (const dir of dirs) {
    const skillPath = join(SKILLS_ROOT, dir, 'SKILL.md');
    let raw: string;
    try {
      raw = readFileSync(skillPath, 'utf8');
    } catch {
      continue; // no SKILL.md in this dir — not a skill folder, don't count as "found"
    }
    found++;

    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(raw);
    } catch (e) {
      skipped.push({ dir, reason: `parse-error: ${(e as Error).message}` });
      continue;
    }
    if (!parsed) {
      skipped.push({ dir, reason: 'no-frontmatter' });
      continue;
    }

    const { attrs, body } = parsed;
    const name = (attrs.name || dir).trim();
    const description = (attrs.description || '').trim();
    const bodyTrimmed = body.trim();

    const flags = scanQuality(bodyTrimmed);
    if (flags.includes('too-short')) {
      skipped.push({ dir, reason: 'too-short (<80 chars body)' });
      continue;
    }
    const secretFlags = flags.filter((f) => f.startsWith('secret:'));
    const destructiveFlags = flags.filter((f) => f.startsWith('destructive:'));
    if (secretFlags.length) {
      skipped.push({ dir, reason: `secret-pattern: ${secretFlags.join(',')}` });
      continue;
    }
    if (destructiveFlags.length) {
      skipped.push({ dir, reason: `destructive-shell: ${destructiveFlags.join(',')}` });
      continue;
    }

    const slug = slugify(name, dir);
    if (seenSlugs.has(slug)) {
      skipped.push({ dir, reason: `duplicate-slug: ${slug}` });
      continue;
    }
    seenSlugs.add(slug);

    results.push({
      slug,
      name,
      description: description || `Imported skill: ${name}`,
      category: mapCategory(dir),
      instructions: bodyTrimmed,
      source: 'adclaw',
      license,
      inspiredBy: `adclaw agent skill: src/adclaw/agents/skills/${dir}/SKILL.md`,
    });
    imported++;
  }

  const header = `// AUTO-GENERATED by scripts/harvest-skills.ts — DO NOT EDIT BY HAND.
// Source: adclaw (${license}), src/adclaw/agents/skills/*/SKILL.md
// Regenerate with: npx tsx scripts/harvest-skills.ts
//
// These are catalog entries (migration 025_skills.sql \`skills\` table seed
// candidates / static fallback) — NOT auto-wired into the agent's default
// system prompt. A skill only affects behavior once an account explicitly
// enables it via account_skills (see app/api/skills routes + lib/agent/loop.ts).

export interface HarvestedSkill {
  slug: string;
  name: string;
  description: string;
  category: string;
  instructions: string;
  source: string;
  license: string;
  inspiredBy: string;
}

export const HARVESTED_SKILLS: HarvestedSkill[] = ${JSON.stringify(results, null, 2)};
`;

  writeFileSync(OUTPUT_FILE, header, 'utf8');

  const elapsedMs = Date.now() - startedAt;
  console.log(`[harvest-skills] SKILL.md found: ${found}`);
  console.log(`[harvest-skills] imported: ${imported}`);
  console.log(`[harvest-skills] skipped: ${skipped.length}`);
  for (const s of skipped) console.log(`  - ${s.dir}: ${s.reason}`);
  console.log(`[harvest-skills] wrote ${OUTPUT_FILE}`);
  console.log(`[harvest-skills] done in ${elapsedMs}ms`);
}

main();

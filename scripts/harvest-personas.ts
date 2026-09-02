// scripts/harvest-personas.ts
//
// One-shot, offline import: read 24 agent definitions out of digital-marketing-pro,
// 5 persona templates out of adclaw, and 204 agent definitions out of
// gtm-agents, and emit a typed lib/agent/harvested-personas.ts array. This is
// a PURE, SYNCHRONOUS, LOCAL FILE-PARSING script — no LLM/AI calls, no
// network, no MCP, no subprocesses (the commit SHA is read out of .git/, not
// via `git`). The adclaw Python file is parsed with a REGEX/string parser —
// Python is never executed. A single malformed source file is skipped with a
// warning, never fatal — the whole run must finish in well under 30s.
//
// A persona in this system is the VOICE AND FRAMEWORK that executes a skill —
// tone, framing, judgement, boundaries — so `instructions` below is captured
// IN FULL. Do not truncate, summarize, or slice it; that was the bug this
// script exists to fix.
//
// Run with:
//   HARVEST_ROOT=/path/to/clones npx tsx scripts/harvest-personas.ts
//   npx tsx scripts/harvest-personas.ts /path/to/clones
//
// Unlike harvest-skills.ts's oss-repos convention (one flat directory per
// repo), these three sources were handed over already cloned at
// `<root>/<owner>/<repo>` (matching their disk layout: <root>/indranilbanerjee
// /digital-marketing-pro, <root>/citedy/adclaw and <root>/gtmagents/gtm-agents),
// so HARVEST_ROOT here is the directory that CONTAINS the owner directories,
// not the repo directories directly. The default (no argv, no env var) is one
// level above this repo checkout — i.e. where these repos actually live in
// this environment:
//   npx tsx scripts/harvest-personas.ts
// is sufficient as-is; HARVEST_ROOT only needs setting if the clones move.
//
// The clone root MUST live outside this git tree; vendored upstream source is
// never committed, only the normalised content this script emits.
//
// Clone with:
//   git clone --depth 1 https://github.com/indranilbanerjee/digital-marketing-pro
//   git clone --depth 1 https://github.com/Citedy/adclaw
//   git clone --depth 1 https://github.com/gtmagents/gtm-agents

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { writeNoticeSection } from './lib/notice';

const REPO_ROOT = join(__dirname, '..');
const DEFAULT_ROOT = join(REPO_ROOT, '..');
const HARVEST_ROOT = process.argv[2] || process.env.HARVEST_ROOT || DEFAULT_ROOT;
const OUTPUT_FILE = join(REPO_ROOT, 'lib', 'agent', 'harvested-personas.ts');

// ---------------------------------------------------------------------------
// Domain gating (see task brief). digital-marketing-pro and adclaw never
// assign 'outreach' — LeadRail had zero outreach-domain personas until the
// gtm-agents source below, whose 14 sales/outreach plugins are the first
// source to use that value.
// ---------------------------------------------------------------------------
type Domain = 'marketing' | 'outreach' | 'shared';

interface HarvestedPersonaRaw {
  slug: string;
  name: string;
  description: string;
  role: string;
  instructions: string;
  domain: Domain;
  sourceRepo: string;
  sourceCommit: string;
  sourcePath: string;
  license: string;
}

// ---------------------------------------------------------------------------
// Commit SHA — read out of .git/ directly. No subprocess, no network.
// Identical logic to harvest-skills.ts's readGitSha.
// ---------------------------------------------------------------------------
function readGitSha(repoPath: string): string {
  const gitDir = join(repoPath, '.git');
  let head: string;
  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
  if (/^[0-9a-f]{40}$/i.test(head)) return head;
  const m = head.match(/^ref:\s*(.+)$/);
  if (!m) return 'unknown';
  const ref = m[1].trim();
  try {
    const direct = readFileSync(join(gitDir, ...ref.split('/')), 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(direct)) return direct;
  } catch {
    /* fall through to packed-refs */
  }
  try {
    const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split(/\r?\n/)) {
      if (line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.split(/\s+/);
      if (name === ref || name === ref.replace('refs/heads/', 'refs/remotes/origin/')) return sha;
    }
  } catch {
    /* no packed-refs */
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Minimal YAML frontmatter parser — flat `key: value` pairs plus quoted-string
// values, same bounded heuristic as harvest-skills.ts's parseFrontmatter.
// ---------------------------------------------------------------------------
function parseFrontmatter(raw: string): { attrs: Record<string, string>; body: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const [, fmBlock, body] = m;
  const attrs: Record<string, string> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv && !/^\s/.test(line)) {
      const [, key, rawValue] = kv;
      let value = rawValue.trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      attrs[key] = value.replace(/\\"/g, '"');
    }
  }
  return { attrs, body };
}

// ---------------------------------------------------------------------------
// Source A — digital-marketing-pro: 24 agents at agents/<slug>.md
// ---------------------------------------------------------------------------
const DMP_OWNER = 'indranilbanerjee';
const DMP_REPO_NAME = 'digital-marketing-pro';
const DMP_REPO = `${DMP_OWNER}/${DMP_REPO_NAME}`;
const DMP_LICENSE = 'MIT';

interface Skipped {
  path: string;
  reason: string;
}

function harvestDmp(root: string, skipped: Skipped[]): HarvestedPersonaRaw[] {
  const repoPath = join(root, DMP_OWNER, DMP_REPO_NAME);
  if (!existsSync(repoPath)) {
    throw new Error(`[digital-marketing-pro] clone missing at ${repoPath}`);
  }
  const commit = readGitSha(repoPath);
  const agentsDir = join(repoPath, 'agents');
  let files: string[];
  try {
    files = readdirSync(agentsDir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort();
  } catch (e) {
    throw new Error(`[digital-marketing-pro] cannot read ${agentsDir}: ${(e as Error).message}`);
  }

  const out: HarvestedPersonaRaw[] = [];
  for (const file of files) {
    const full = join(agentsDir, file);
    const relPath = `agents/${file}`;
    let raw: string;
    try {
      raw = readFileSync(full, 'utf8');
    } catch (e) {
      skipped.push({ path: relPath, reason: `read-error: ${(e as Error).message}` });
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      skipped.push({ path: relPath, reason: 'no-frontmatter' });
      continue;
    }
    const { attrs, body } = parsed;
    const slugAttr = (attrs.name || '').trim();
    const description = (attrs.description || '').trim();
    if (!slugAttr || !description) {
      skipped.push({ path: relPath, reason: 'missing name/description in frontmatter' });
      continue;
    }
    const fileStem = file.replace(/\.md$/i, '');
    if (slugAttr !== fileStem) {
      console.warn(`[harvest-personas] WARNING [dmp] frontmatter name "${slugAttr}" != filename stem "${fileStem}" (${relPath})`);
    }

    const instructions = body.trim();
    if (!instructions) {
      skipped.push({ path: relPath, reason: 'empty body after frontmatter' });
      continue;
    }

    // Display name: the H1 heading of the body ("# Content Creator Agent"),
    // which is what the CURRENT (bugged) file's `name` values came from. Falls
    // back to a title-cased slug — and says so — only if a file has no H1.
    const h1 = instructions.match(/^#\s+(.+?)\s*$/m);
    let name: string;
    if (h1) {
      name = h1[1].trim();
    } else {
      name = slugAttr
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      console.warn(`[harvest-personas] WARNING [dmp] no H1 heading in ${relPath}; title-cased slug used as name: "${name}"`);
    }

    out.push({
      slug: slugAttr,
      name,
      description,
      role: slugAttr,
      instructions,
      domain: 'marketing',
      sourceRepo: DMP_REPO,
      sourceCommit: commit,
      sourcePath: relPath,
      license: DMP_LICENSE,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source B — adclaw: 5 persona templates in
// src/adclaw/agents/persona_templates.py, a Python list-of-dicts literal.
// Parsed with a REGEX/string parser — Python is never executed, no Python
// dependency is added.
// ---------------------------------------------------------------------------
const ADCLAW_DISK_OWNER = 'citedy'; // on-disk directory name (lowercase)
const ADCLAW_REPO = 'Citedy/adclaw'; // canonical attribution string
const ADCLAW_REPO_NAME = 'adclaw';
const ADCLAW_LICENSE = 'Apache-2.0';

/** domain per the task brief: researcher/content-writer -> shared;
 *  seo-specialist/ads-manager/social-media -> marketing. */
const ADCLAW_DOMAIN: Record<string, Domain> = {
  researcher: 'shared',
  'content-writer': 'shared',
  'seo-specialist': 'marketing',
  'ads-manager': 'marketing',
  'social-media': 'marketing',
};

/** slug collision with digital-marketing-pro's `seo-specialist`: every
 *  adclaw entry is prefixed `adclaw-` uniformly (not just the colliding one),
 *  so the disambiguation rule is the same for all five regardless of whether
 *  a given id happens to collide today. This keeps the rule stable if either
 *  source's slugs change later, and it is the ONLY prefixing in this script —
 *  digital-marketing-pro slugs are emitted verbatim so the 118 `Agents Used`
 *  bold-token references in lib/skills/harvested.ts keep resolving to THESE
 *  (dmp) entries, never to the adclaw ones. */
function adclawSlug(id: string): string {
  return `adclaw-${id}`;
}

/** Extracts one `"key": value,` or `"key": """...""",` entry's raw text for a
 *  dict literal spanning `start`..`end` in `src`. Returns null if the key is
 *  absent — a malformed entry is skipped, not fatal. */
function extractPyString(dictText: string, key: string): string | null {
  // Triple-quoted string value: "key": """....""" (allow either quote style).
  const triple = new RegExp(`"${key}"\\s*:\\s*"""([\\s\\S]*?)"""`);
  const tripleMatch = dictText.match(triple);
  if (tripleMatch) return tripleMatch[1];
  // Single-line quoted string value: "key": "...."
  const single = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const singleMatch = dictText.match(single);
  if (singleMatch) return singleMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
  return null;
}

/** Splits `TEMPLATES = [ {...}, {...}, ... ]` into each top-level `{...}`
 *  dict's raw text via brace-depth counting (bounded, no external parser). */
function splitTopLevelDicts(listBody: string): string[] {
  const dicts: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < listBody.length; i++) {
    const c = listBody[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        dicts.push(listBody.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return dicts;
}

/** Derives a short description from the `## Role` section of soul_md: the
 *  text between `## Role` and the next `##` heading (or end of string),
 *  trimmed. adclaw's Role sections are already 1-2 short sentences, so this
 *  is used verbatim rather than re-splitting into "the first sentence or
 *  two" — splitting further would just re-truncate what is already short. */
function deriveAdclawDescription(soulMd: string): string {
  const m = soulMd.match(/##\s*Role\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/);
  return m ? m[1].trim().replace(/\s*\n\s*/g, ' ') : '';
}

function harvestAdclaw(root: string, skipped: Skipped[]): HarvestedPersonaRaw[] {
  const repoPath = join(root, ADCLAW_DISK_OWNER, ADCLAW_REPO_NAME);
  if (!existsSync(repoPath)) {
    throw new Error(`[adclaw] clone missing at ${repoPath}`);
  }
  const commit = readGitSha(repoPath);
  const pyFile = join(repoPath, 'src', 'adclaw', 'agents', 'persona_templates.py');
  const relPath = 'src/adclaw/agents/persona_templates.py';
  let raw: string;
  try {
    raw = readFileSync(pyFile, 'utf8');
  } catch (e) {
    throw new Error(`[adclaw] cannot read ${pyFile}: ${(e as Error).message}`);
  }

  const listMatch = raw.match(/TEMPLATES\s*=\s*\[([\s\S]*)\]\s*$/m);
  if (!listMatch) {
    skipped.push({ path: relPath, reason: 'TEMPLATES = [...] literal not found' });
    return [];
  }
  const dictTexts = splitTopLevelDicts(listMatch[1]);

  const out: HarvestedPersonaRaw[] = [];
  for (const dictText of dictTexts) {
    const id = extractPyString(dictText, 'id');
    const name = extractPyString(dictText, 'name');
    const soulMd = extractPyString(dictText, 'soul_md');
    if (!id || !name || !soulMd) {
      skipped.push({ path: relPath, reason: `malformed TEMPLATES entry (missing id/name/soul_md): ${dictText.slice(0, 80)}...` });
      continue;
    }
    const domain = ADCLAW_DOMAIN[id];
    if (!domain) {
      skipped.push({ path: relPath, reason: `unrecognised adclaw persona id "${id}" — not in the documented domain map` });
      continue;
    }
    const instructions = soulMd.trim();
    out.push({
      slug: adclawSlug(id),
      name,
      description: deriveAdclawDescription(soulMd),
      role: id,
      instructions,
      domain,
      sourceRepo: ADCLAW_REPO,
      sourceCommit: commit,
      sourcePath: relPath,
      license: ADCLAW_LICENSE,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source C — gtm-agents: 204 agents at plugins/<plugin>/agents/<slug>.md
// across 67 plugins. Same frontmatter shape as digital-marketing-pro
// (`name` + `description`, plus a `model` key this script ignores — model
// routing stays LeadRail's own).
//
// THE GAP THIS SOURCE CLOSES: LeadRail had 29 harvested personas — 27
// 'marketing', 2 'shared', ZERO 'outreach' — on an outreach product.
// coldoutboundskills (harvest-skills.ts) supplied 50 cold-outbound SKILLS but
// ships no agents/ directory, so there was never an outreach PERSONA to
// import until now. The 14 plugins in GTM_OUTREACH_PLUGINS below are the
// outreach side of gtm-agents' 67 plugins; everything else is classified
// 'marketing' or 'shared' by judgement (see GTM_MARKETING_PLUGINS /
// GTM_SHARED_PLUGINS) — never left to infer from name alone.
// ---------------------------------------------------------------------------
const GTM_OWNER = 'gtmagents'; // on-disk directory name
const GTM_REPO = 'gtmagents/gtm-agents'; // canonical attribution string
const GTM_REPO_NAME = 'gtm-agents';
const GTM_LICENSE = 'Apache-2.0';

/** Sales/outreach plugins — the point of this whole harvest. ~44 agents,
 *  including outreach-specialist, lead-researcher, qualification-expert,
 *  social-seller, deliverability-lead, email-architect, enrichment-expert,
 *  intent-analyst. */
const GTM_OUTREACH_PLUGINS = new Set([
  'sales-prospecting',
  'enterprise-sales',
  'sales-pipeline',
  'lead-nurture-orchestration',
  'email-sequence-orchestration',
  'abm-orchestration',
  'sales-operations',
  'sales-enablement',
  'sales-calls',
  'sales-coaching',
  'sales-handoff-orchestration',
  'intent-signal-orchestration',
  'data-enrichment-master',
  'account-management',
]);

/** Marketing-channel and content plugins: campaign execution, content,
 *  brand, paid/organic channels, vertical marketing playbooks. */
const GTM_MARKETING_PLUGINS = new Set([
  'brand-strategy',
  'campaign-orchestration',
  'community-building',
  'community-orchestration',
  'content-marketing',
  'content-pipeline-orchestration',
  'copywriting',
  'customer-advocacy-orchestration',
  'customer-marketing',
  'design-creative',
  'e-commerce',
  'edtech-growth',
  'email-marketing',
  'event-marketing',
  'financial-services',
  'healthcare-marketing',
  'loyalty-lifecycle-orchestration',
  'paid-media',
  'partner-co-marketing-orchestration',
  'pr-communications',
  'product-launch-orchestration',
  'product-marketing',
  'referral-program-orchestration',
  'seo',
  'seo-workflow-orchestration',
  'social-media',
  'social-media-marketing',
  'social-scheduler-orchestration',
  'technical-writing',
  'video-marketing',
  'webinar-automation',
  'marketing-analytics',
  'marketing-automation',
]);

/** Cross-cutting plugins: research, analytics, revenue/CS orchestration and
 *  vertical GTM strategy that is not specifically an outreach mechanism or a
 *  marketing content channel — applies to both surfaces, same spirit as
 *  adclaw's researcher/content-writer 'shared' tagging. */
const GTM_SHARED_PLUGINS = new Set([
  'analytics-pipeline-orchestration',
  'b2b-saas',
  'business-intelligence',
  'competitive-intelligence',
  'customer-analytics',
  'customer-feedback-orchestration',
  'customer-journey-orchestration',
  'customer-success',
  'data-signal-enrichment',
  'growth-experiments',
  'manufacturing-sales',
  'market-research',
  'partnership-development',
  'personalization-engine',
  'pricing-strategy',
  'product-led-growth',
  'renewal-orchestration',
  'revenue-analytics',
  'revenue-forecasting-pipeline',
  'voice-of-customer',
]);

function gtmDomainForPlugin(plugin: string): Domain | null {
  if (GTM_OUTREACH_PLUGINS.has(plugin)) return 'outreach';
  if (GTM_MARKETING_PLUGINS.has(plugin)) return 'marketing';
  if (GTM_SHARED_PLUGINS.has(plugin)) return 'shared';
  return null;
}

/** Slug collisions with digital-marketing-pro (and within gtm-agents itself —
 *  three agent basenames, e.g. "research-lead", repeat across different
 *  plugins) are certain. Every gtm-agents entry is uniformly prefixed with
 *  its plugin, "gtm-<plugin>-<agent-slug>" — not just the colliding ones, so
 *  the rule stays stable — which also happens to be exactly the shape
 *  harvest-skills.ts's sibling-agents lookup emits for a skill's `personas`
 *  field, so the two line up without a second mapping. digital-marketing-pro
 *  and adclaw slugs are untouched, so the 210 existing "Agents Used"
 *  references keep resolving only to them. */
function gtmSlug(plugin: string, agentSlug: string): string {
  return `gtm-${plugin}-${agentSlug}`;
}

function harvestGtm(root: string, skipped: Skipped[]): HarvestedPersonaRaw[] {
  const repoPath = join(root, GTM_OWNER, GTM_REPO_NAME);
  if (!existsSync(repoPath)) {
    throw new Error(`[gtm-agents] clone missing at ${repoPath}`);
  }
  const commit = readGitSha(repoPath);
  const pluginsDir = join(repoPath, 'plugins');
  let plugins: string[];
  try {
    plugins = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (e) {
    throw new Error(`[gtm-agents] cannot read ${pluginsDir}: ${(e as Error).message}`);
  }

  const out: HarvestedPersonaRaw[] = [];
  for (const plugin of plugins) {
    const domain = gtmDomainForPlugin(plugin);
    if (!domain) {
      skipped.push({ path: `plugins/${plugin}`, reason: `unrecognised gtm-agents plugin "${plugin}" — not in the documented domain map` });
      continue;
    }
    const agentsDir = join(pluginsDir, plugin, 'agents');
    let files: string[];
    try {
      files = readdirSync(agentsDir)
        .filter((f) => f.toLowerCase().endsWith('.md'))
        .sort();
    } catch (e) {
      skipped.push({ path: `plugins/${plugin}/agents`, reason: `cannot read: ${(e as Error).message}` });
      continue;
    }

    for (const file of files) {
      const full = join(agentsDir, file);
      const relPath = `plugins/${plugin}/agents/${file}`;
      let raw: string;
      try {
        raw = readFileSync(full, 'utf8');
      } catch (e) {
        skipped.push({ path: relPath, reason: `read-error: ${(e as Error).message}` });
        continue;
      }
      const parsed = parseFrontmatter(raw);
      if (!parsed) {
        skipped.push({ path: relPath, reason: 'no-frontmatter' });
        continue;
      }
      const { attrs, body } = parsed;
      const agentSlug = (attrs.name || '').trim();
      const description = (attrs.description || '').trim();
      if (!agentSlug || !description) {
        skipped.push({ path: relPath, reason: 'missing name/description in frontmatter' });
        continue;
      }
      const fileStem = file.replace(/\.md$/i, '');
      if (agentSlug !== fileStem) {
        console.warn(`[harvest-personas] WARNING [gtm] frontmatter name "${agentSlug}" != filename stem "${fileStem}" (${relPath})`);
      }

      const instructions = body.trim();
      if (!instructions) {
        skipped.push({ path: relPath, reason: 'empty body after frontmatter' });
        continue;
      }

      const h1 = instructions.match(/^#\s+(.+?)\s*$/m);
      let name: string;
      if (h1) {
        name = h1[1].trim();
      } else {
        name = agentSlug
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        console.warn(`[harvest-personas] WARNING [gtm] no H1 heading in ${relPath}; title-cased slug used as name: "${name}"`);
      }

      out.push({
        slug: gtmSlug(plugin, agentSlug),
        name,
        description,
        role: agentSlug,
        instructions,
        domain,
        sourceRepo: GTM_REPO,
        sourceCommit: commit,
        sourcePath: relPath,
        license: GTM_LICENSE,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const startedAt = Date.now();

  if (!existsSync(HARVEST_ROOT)) {
    throw new Error(
      `Clone root not found: ${HARVEST_ROOT}\n` +
        `Pass it as argv[2] or set HARVEST_ROOT. It must contain <owner>/<repo> checkouts for both sources, and must be OUTSIDE this git tree.`,
    );
  }
  if (!relative(REPO_ROOT, HARVEST_ROOT).startsWith('..')) {
    throw new Error(`Clone root ${HARVEST_ROOT} is inside the repo tree. Clone upstreams outside ${REPO_ROOT}.`);
  }

  const skipped: Skipped[] = [];
  const dmp = harvestDmp(HARVEST_ROOT, skipped);
  const adclaw = harvestAdclaw(HARVEST_ROOT, skipped);
  const gtm = harvestGtm(HARVEST_ROOT, skipped);

  const all = [...dmp, ...adclaw, ...gtm].sort((a, b) => a.slug.localeCompare(b.slug));

  // Slug uniqueness — fail closed, this is the whole point of the adclaw
  // prefix rule above.
  const seen = new Set<string>();
  for (const p of all) {
    if (seen.has(p.slug)) throw new Error(`Duplicate persona slug after harvesting: ${p.slug}`);
    seen.add(p.slug);
  }

  const dmpCommit = dmp[0]?.sourceCommit ?? 'unknown';
  const adclawCommit = adclaw[0]?.sourceCommit ?? 'unknown';
  const gtmCommit = gtm[0]?.sourceCommit ?? 'unknown';

  const header = `// AUTO-GENERATED by scripts/harvest-personas.ts — DO NOT EDIT BY HAND.
// Regenerate with: HARVEST_ROOT=<clone-root-containing-owner-dirs> npx tsx scripts/harvest-personas.ts
// (HARVEST_ROOT defaults to the directory one level above this repo checkout,
// which is where all three sources below are cloned as <root>/<owner>/<repo>.)
//
// Sources (all permissively licensed; see the root NOTICE file):
//   - ${DMP_REPO} (${DMP_LICENSE}) @ ${dmpCommit} — ${dmp.length} agents (agents/<slug>.md)
//   - ${ADCLAW_REPO} (${ADCLAW_LICENSE}) @ ${adclawCommit} — ${adclaw.length} persona templates
//     (src/adclaw/agents/persona_templates.py; slugs prefixed "adclaw-" to
//     avoid colliding with digital-marketing-pro slugs — see adclawSlug() in
//     the harvester. digital-marketing-pro slugs are emitted VERBATIM so the
//     "Agents Used" references in lib/skills/harvested.ts keep resolving to
//     them.)
//   - ${GTM_REPO} (${GTM_LICENSE}) @ ${gtmCommit} — ${gtm.length} agents
//     (plugins/<plugin>/agents/<slug>.md across 67 plugins; slugs prefixed
//     "gtm-<plugin>-" — see gtmSlug() in the harvester. 14 sales/outreach
//     plugins are domain 'outreach' — the first source with that value; the
//     rest are 'marketing' or 'shared' — see GTM_OUTREACH_PLUGINS /
//     GTM_MARKETING_PLUGINS / GTM_SHARED_PLUGINS in the harvester.)
//
// A persona here is the VOICE AND FRAMEWORK that executes a skill — tone,
// framing, judgement, boundaries — so \`instructions\` is the upstream agent's
// / persona's FULL body, uncapped.
//
// These are catalog entries (migration 024 \`personas\` table seed candidates /
// static fallback) — NOT auto-created persona rows, and NOT wired into the
// agent loop or prompt injection. A template is inert until a follow-up
// packet does that wiring; today this file is imported by nothing.

export type HarvestedPersonaDomain = 'marketing' | 'outreach' | 'shared';

export interface HarvestedPersonaTemplate {
  slug: string;
  name: string;
  description: string;
  role: string;
  instructions: string;
  /** Which product surface this persona applies to. digital-marketing-pro
   *  and adclaw never assign 'outreach'; gtm-agents' 14 sales/outreach
   *  plugins are the first (and, today, only) source of that value. */
  domain: HarvestedPersonaDomain;
  /** Upstream repo, e.g. "indranilbanerjee/digital-marketing-pro". */
  sourceRepo: string;
  /** Upstream commit SHA this content was harvested from. */
  sourceCommit: string;
  /** Repo-relative path of the upstream agent/persona definition. */
  sourcePath: string;
  license: string;
}

export const HARVESTED_PERSONA_TEMPLATES: HarvestedPersonaTemplate[] = ${JSON.stringify(all, null, 2)};
`;
  writeFileSync(OUTPUT_FILE, header, 'utf8');

  // ---------------------------------------------------------------------------
  // Emit this script's OWN section of the root NOTICE (BACKLOG 5c, residual).
  // Previously this script's persona attribution existed only inside
  // harvest-skills.ts's wholesale NOTICE write, so it had no writer of its
  // own here at all — a re-run of harvest-skills.ts silently dropped it. See
  // scripts/lib/notice.ts: this call touches ONLY the PERSONAS section,
  // regardless of whether harvest-skills.ts has ever run on this machine.
  // ---------------------------------------------------------------------------
  const personaNoticeSources = `${DMP_REPO}
  License:   ${DMP_LICENSE}
  Commit:    ${dmpCommit}
  Used for:  ${dmp.length} normalised persona-template entries in lib/agent/harvested-personas.ts (one per agents/<slug>.md)
  Notes:     MIT — attribution retained here as a courtesy and audit trail.

${ADCLAW_REPO}
  License:   ${ADCLAW_LICENSE}
  Commit:    ${adclawCommit}
  Used for:  ${adclaw.length} normalised persona-template entries (slugs "adclaw-*") in lib/agent/harvested-personas.ts
  Notes:     Apache-2.0 §4 attribution — see the copyright line in the section above.

${GTM_REPO}
  License:   ${GTM_LICENSE}
  Commit:    ${gtmCommit}
  Used for:  ${gtm.length} normalised persona-template entries (slugs "gtm-<plugin>-*") in lib/agent/harvested-personas.ts
  Notes:     Apache-2.0 §4 attribution — see the copyright line in the section above.`;

  const personasSection = `--------------------------------------------------------------------------------
Persona-template content (scripts/harvest-personas.ts -> lib/agent/harvested-personas.ts)
--------------------------------------------------------------------------------

No upstream source code is executed, imported, or distributed for these
sources — only normalised persona-template text (\`instructions\`, verbatim).

--------------------------------------------------------------------------------
Apache License 2.0 attribution
--------------------------------------------------------------------------------

Citedy/adclaw

  Copyright 2025 The CoPaw Authors

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.

  Persona content from src/adclaw/agents/persona_templates.py (the 5 entries
  of the TEMPLATES list) is used with only the \`soul_md\` field's structure
  preserved verbatim as \`instructions\`; slugs were prefixed "adclaw-" to
  avoid colliding with digital-marketing-pro's persona slugs.

gtmagents/gtm-agents

  Copyright 2025 LaunchIQ AI, Inc.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.

  Persona content from the ${gtm.length} files under plugins/*/agents/*.md is
  used verbatim as \`instructions\`; slugs were prefixed "gtm-<plugin>-" to
  avoid colliding with digital-marketing-pro's persona slugs and with each
  other (a handful of agent filenames repeat across different plugins).

--------------------------------------------------------------------------------
All sources
--------------------------------------------------------------------------------

${personaNoticeSources}`;
  writeNoticeSection('PERSONAS', personasSection);

  const elapsedMs = Date.now() - startedAt;
  console.log(`[harvest-personas] digital-marketing-pro: ${dmp.length} personas @ ${dmpCommit.slice(0, 12)}`);
  console.log(`[harvest-personas] adclaw: ${adclaw.length} personas @ ${adclawCommit.slice(0, 12)}`);
  console.log(`[harvest-personas] gtm-agents: ${gtm.length} personas @ ${gtmCommit.slice(0, 12)}`);
  console.log(`[harvest-personas] skipped: ${skipped.length}`);
  for (const s of skipped) console.log(`    - ${s.path}: ${s.reason}`);
  console.log(`[harvest-personas] TOTAL: ${all.length}`);
  console.log(`[harvest-personas] wrote ${OUTPUT_FILE}`);
  console.log(`[harvest-personas] wrote NOTICE (PERSONAS section)`);
  console.log(`[harvest-personas] done in ${elapsedMs}ms`);
}

main();

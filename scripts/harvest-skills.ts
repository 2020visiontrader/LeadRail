// scripts/harvest-skills.ts
//
// One-shot, offline import: walk four permissively-licensed OSS repos' SKILL.md
// files and emit a typed lib/skills/harvested.ts array plus a root NOTICE.
// This is a PURE, SYNCHRONOUS, LOCAL FILE-PARSING script — no LLM/AI calls, no
// network, no MCP, no subprocesses (the commit SHA is read out of .git/, not
// via `git`). The "quality/security scan" below is regex/string heuristics
// ONLY. A single malformed SKILL.md is skipped, never fatal — the whole run
// must finish in well under 30s.
//
// Run with:
//   HARVEST_ROOT=/path/to/oss-repos npx tsx scripts/harvest-skills.ts
//   npx tsx scripts/harvest-skills.ts /path/to/oss-repos
//
// The clone root MUST live outside this git tree; vendored upstream source is
// never committed, only the normalised content this script emits.
//
// Clone with:
//   git clone --depth 1 https://github.com/indranilbanerjee/digital-marketing-pro
//   git clone --depth 1 https://github.com/Citedy/adclaw
//   git clone --depth 1 https://github.com/cgallic/kai-cmo-harness
//   git clone --depth 1 https://github.com/ericosiu/marketing-os-starter
//
// Packet 5.2 — the marketing-os-arsenal group. Eight MIT repos, each a single
// skill collection rather than a monorepo, all verified MIT with a root LICENSE
// before being listed here:
//   git clone --depth 1 https://github.com/zubair-trabzada/geo-seo-claude
//   git clone --depth 1 https://github.com/charlesdove977/UGC-Factory
//   git clone --depth 1 https://github.com/charlesdove977/advertising-ops
//   git clone --depth 1 https://github.com/charlesdove977/goviralbro
//   git clone --depth 1 https://github.com/charlesdove977/linkedin-automator
//   git clone --depth 1 https://github.com/charlesdove977/re-walkthrough-pro
//   git clone --depth 1 https://github.com/Hao0321/claude-skill-social-post
//   git clone --depth 1 https://github.com/wshuyi/x-article-publisher-skill
//
// coldoutboundskills carries ~480MB of lead-list zips alongside its skills, and
// a full clone reliably times out. Fetch only what is read:
//   git clone --filter=blob:none --sparse --depth 1 \
//     https://github.com/growthenginenowoslawski/coldoutboundskills
//   cd coldoutboundskills && git sparse-checkout set skills LICENSE   # 2.7MB

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { writeNoticeSection } from './lib/notice';

const DEFAULT_ROOT = join(__dirname, '..', '..', 'oss-repos');
const HARVEST_ROOT = process.argv[2] || process.env.HARVEST_ROOT || DEFAULT_ROOT;
const REPO_ROOT = join(__dirname, '..');
const OUTPUT_FILE = join(REPO_ROOT, 'lib', 'skills', 'harvested.ts');
const MIN_BODY_LENGTH = 80;

// ---------------------------------------------------------------------------
// Source table.
//
// `licenseMode`:
//   'root'              — one root LICENSE governs the whole repo. Correct for
//                         adclaw / digital-marketing-pro / marketing-os-starter.
//   'subtree-allowlist' — the ROOT license does NOT govern. Only the listed
//                         subtrees are permissive, each carrying its own
//                         LICENSE, and the allowlist is enforced against EVERY
//                         accepted file path. This is the kai-cmo-harness case:
//                         its root LICENSE is Elastic-2.0, so a root-level check
//                         would either abort the import or — if someone relaxed
//                         the gate to make the abort go away — wave
//                         Elastic-licensed content into a commercial product.
//                         See that repo's LICENSING.md, which is authoritative.
//
// `dialect` is deliberately per-source. The four upstreams use different
// frontmatter shapes; widening one loose parser across all of them would let a
// malformed mapping pass silently.
// ---------------------------------------------------------------------------
type Dialect = 'adclaw' | 'dmp' | 'kai' | 'mos' | 'arsenal';

interface SourceSpec {
  key: string;
  repo: string;
  dir: string;
  licenseMode: 'root' | 'subtree-allowlist';
  expectLicense: 'Apache-2.0' | 'MIT';
  /** Directories (repo-relative) walked for SKILL.md files. */
  skillRoots: string[];
  /**
   * Only for 'subtree-allowlist': every accepted file's repo-relative path must
   * start with one of these prefixes, and each prefix must itself carry an MIT
   * LICENSE. Anything else is a hard abort, not a skip.
   */
  pathAllowlist?: string[];
  dialect: Dialect;
  /** Lower wins a dedupe tie when instruction bodies are the same length. */
  priority: number;
  /** Attribution required by the licence (Apache-2.0 §4). */
  requiresNotice: boolean;
}

const SOURCES: SourceSpec[] = [
  {
    key: 'adclaw',
    repo: 'Citedy/adclaw',
    dir: 'adclaw',
    licenseMode: 'root',
    expectLicense: 'Apache-2.0',
    skillRoots: ['src/adclaw/agents/skills'],
    dialect: 'adclaw',
    priority: 1,
    requiresNotice: true,
  },
  {
    key: 'digital-marketing-pro',
    repo: 'indranilbanerjee/digital-marketing-pro',
    dir: 'digital-marketing-pro',
    licenseMode: 'root',
    expectLicense: 'MIT',
    skillRoots: ['skills'],
    dialect: 'dmp',
    priority: 2,
    requiresNotice: false,
  },
  {
    key: 'kai-cmo-harness',
    repo: 'cgallic/kai-cmo-harness',
    dir: 'kai-cmo-harness',
    licenseMode: 'subtree-allowlist',
    expectLicense: 'MIT',
    // `harness/` and `plugins/` are the SAME skills materialised twice (the
    // installer copies one into the other), so only `harness/` is walked —
    // `plugins/` would just double the dedupe pass's work. `legacy/` is
    // Elastic-2.0 and is not in the allowlist at all.
    skillRoots: ['harness'],
    pathAllowlist: [
      'harness',
      'knowledge',
      'docs',
      'plugins',
      'scripts/quality_gates',
      'scripts/reddit_monitor',
    ],
    dialect: 'kai',
    priority: 3,
    requiresNotice: false,
  },
  {
    key: 'marketing-os-starter',
    repo: 'ericosiu/marketing-os-starter',
    dir: 'marketing-os-starter',
    licenseMode: 'root',
    expectLicense: 'MIT',
    skillRoots: ['.claude/skills'],
    dialect: 'mos',
    priority: 4,
    requiresNotice: false,
  },

  // --- Packet 5.2: the marketing-os-arsenal group ------------------------
  //
  // Appended, never interleaved: `priority` breaks a dedupe tie, so inserting
  // above an existing source would silently change which copy of a duplicated
  // skill wins. These are all LOWER priority than the original four, so an
  // existing skill keeps its current body.
  //
  // Every entry was licence-checked before being listed — all eight carry a
  // root MIT LICENSE. Deliberately EXCLUDED after inspection:
  //   apify-mcp-server      Apache-2.0, but its only two SKILL.md files are
  //                         repo-internal dev skills (bug-triage, dig).
  //   graphify              a code-graph dev tool, not marketing.
  //   (coldoutboundskills was wrongly excluded here on the first pass and is
  //    now a source below — see the correction note on its entry.)
  //   *-mcp servers         MCP servers, not skill collections; they belong in
  //                         the integrations layer, not the skill catalog.
  {
    key: 'geo-seo-claude',
    repo: 'zubair-trabzada/geo-seo-claude',
    dir: 'geo-seo-claude',
    licenseMode: 'root',
    expectLicense: 'MIT',
    // 16 skills: a coherent generative-engine-optimisation suite (audit,
    // citability, schema, llms.txt, crawlers, prospect, proposal). `geo/` is the
    // orchestrator skill; `skills/` holds the fifteen it delegates to.
    skillRoots: ['geo', 'skills'],
    dialect: 'arsenal',
    priority: 5,
    requiresNotice: false,
  },
  {
    key: 'ugc-factory',
    repo: 'charlesdove977/UGC-Factory',
    dir: 'UGC-Factory',
    licenseMode: 'root',
    expectLicense: 'MIT',
    // 16 skills: one entry point plus fifteen video-ad styles (ecommerce,
    // social-hook, brand-story, fashion, food). Nested under skill/styles/*.
    skillRoots: ['skill'],
    dialect: 'arsenal',
    priority: 6,
    requiresNotice: false,
  },
  {
    key: 'advertising-ops',
    repo: 'charlesdove977/advertising-ops',
    dir: 'advertising-ops',
    licenseMode: 'root',
    expectLicense: 'MIT',
    // Meta Ad Library intelligence. Declares its own `category:` in frontmatter,
    // which the 'arsenal' dialect honours rather than re-inferring.
    skillRoots: ['skill'],
    dialect: 'arsenal',
    priority: 7,
    requiresNotice: false,
  },
  {
    key: 'goviralbro',
    repo: 'charlesdove977/goviralbro',
    dir: 'goviralbro',
    licenseMode: 'root',
    expectLicense: 'MIT',
    // Social performance review. The repo also ships install/cron scripts; those
    // are never read — walkSkillFiles only collects SKILL.md.
    skillRoots: ['skills'],
    dialect: 'arsenal',
    priority: 8,
    requiresNotice: false,
  },
  {
    key: 'linkedin-automator',
    repo: 'charlesdove977/linkedin-automator',
    dir: 'linkedin-automator',
    licenseMode: 'root',
    expectLicense: 'MIT',
    // SKILL.md sits at the repo ROOT, so the skill root is '.'. walkSkillFiles
    // already skips .git/node_modules and matches SKILL.md exactly, so this
    // walks the repo without pulling in anything else.
    skillRoots: ['.'],
    dialect: 'arsenal',
    priority: 9,
    requiresNotice: false,
  },
  {
    key: 're-walkthrough-pro',
    repo: 'charlesdove977/re-walkthrough-pro',
    dir: 're-walkthrough-pro',
    licenseMode: 'root',
    expectLicense: 'MIT',
    // Product walkthrough / demo recording.
    skillRoots: ['skill'],
    dialect: 'arsenal',
    priority: 10,
    requiresNotice: false,
  },
  {
    key: 'claude-skill-social-post',
    repo: 'Hao0321/claude-skill-social-post',
    dir: 'claude-skill-social-post',
    licenseMode: 'root',
    expectLicense: 'MIT',
    // Single social-post composer.
    skillRoots: ['social-post'],
    dialect: 'arsenal',
    priority: 11,
    requiresNotice: false,
  },
  {
    key: 'x-article-publisher',
    repo: 'wshuyi/x-article-publisher-skill',
    dir: 'x-article-publisher-skill',
    licenseMode: 'root',
    expectLicense: 'MIT',
    // Long-form publishing to X.
    skillRoots: ['skills'],
    dialect: 'arsenal',
    priority: 12,
    requiresNotice: false,
  },
  {
    key: 'coldoutboundskills',
    repo: 'growthenginenowoslawski/coldoutboundskills',
    dir: 'coldoutboundskills',
    licenseMode: 'root',
    expectLicense: 'MIT',
    // 50 skills — the largest single addition since the original four, and the
    // deepest coverage of a discipline the catalog barely had: cold outbound.
    // Campaign strategy and copywriting, a fourteen-document deliverability
    // reference, list building and expansion, ICP definition, spam-word and
    // inbox auditing, reply scoring, and twenty Clay playbooks under
    // skills/playbooks.
    //
    // CORRECTION. This repo was excluded on the first pass as "no skills at
    // all". That was wrong, and the reason is worth recording: the clone kept
    // timing out on the zips and left an EMPTY directory, which was then
    // inspected and believed. An empty working tree is not evidence about a
    // repository — the source listing is. Verify against the source, not
    // against whatever a failed command left on disk.
    //
    // ONLY skills/ is walked. The repo also holds ~480MB of scraped lead-list
    // zips and a set of operational .ts scripts; neither is read — walkSkillFiles
    // collects SKILL.md and nothing else — but a full clone times out on the
    // zips, so the header above documents a sparse checkout.
    skillRoots: ['skills'],
    dialect: 'arsenal',
    priority: 13,
    requiresNotice: false,
  },
  {
    key: 'apify-mcp-server',
    repo: 'apify/apify-mcp-server',
    dir: 'apify-mcp-server',
    licenseMode: 'root',
    expectLicense: 'MIT',
    // Two repo-internal engineering skills (bug-triage, dig). Not marketing,
    // and included only because the brief was to harvest everything available
    // rather than only what fits a theme. They land in dev-tooling.
    skillRoots: ['.claude/skills'],
    dialect: 'arsenal',
    priority: 14,
    requiresNotice: false,
  },
  {
    key: 'graphify',
    repo: 'Graphify-Labs/graphify',
    dir: 'graphify',
    licenseMode: 'root',
    expectLicense: 'Apache-2.0',
    // One skill, and the only Apache-2.0 source besides adclaw — so
    // requiresNotice is true and §4 attribution goes in NOTICE.
    // Ships its file as lowercase `skill.md`, which is why walkSkillFiles
    // matches case-insensitively.
    skillRoots: ['graphify'],
    dialect: 'arsenal',
    priority: 15,
    requiresNotice: true,
  },
];

// ---------------------------------------------------------------------------
// Licence gate — fail closed. Any source that cannot be positively identified
// as the licence we expect aborts the whole import.
// ---------------------------------------------------------------------------
function classifyLicense(text: string): 'Apache-2.0' | 'MIT' | 'Elastic-2.0' | 'unknown' {
  const head = text.slice(0, 4000);
  if (/Elastic License 2\.0/i.test(head)) return 'Elastic-2.0';
  if (/Apache License[\s\S]*Version 2\.0/i.test(head)) return 'Apache-2.0';
  if (/MIT License|Permission is hereby granted, free of charge/i.test(head)) return 'MIT';
  return 'unknown';
}

/**
 * Classifier for a SUBTREE LICENSE inside a dual-licensed repo.
 *
 * These files legitimately MENTION the repo's other licence ("The rest of this
 * repository is licensed under the Elastic License 2.0"), so a naive
 * whole-file scan mis-classifies them. Rather than relaxing the gate, this
 * splits the file at the `MIT License` marker and demands three things:
 *
 *   1. the preamble positively asserts THIS directory is MIT,
 *   2. the operative grant after the marker is the MIT grant, and
 *   3. that operative grant makes no mention of any other licence.
 *
 * Anything else fails closed.
 */
function classifySubtreeLicense(text: string, prefix: string): 'MIT' | 'unknown' {
  const markerIdx = text.search(/^MIT License$/m);
  if (markerIdx < 0) return 'unknown';
  const preamble = text.slice(0, markerIdx);
  const grant = text.slice(markerIdx);

  const dirClaim = new RegExp(
    `this directory \\(\`?${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?\`?\\)[\\s\\S]{0,240}?licensed\\s+under\\s+the\\s+MIT`,
    'i',
  );
  if (!dirClaim.test(preamble)) return 'unknown';
  if (!/Permission is hereby granted, free of charge/i.test(grant)) return 'unknown';
  if (/Elastic License|Apache License|GNU (Affero |General )?Public License/i.test(grant)) return 'unknown';
  return 'MIT';
}

/** Root licence filenames, in preference order. Upstreams disagree on the
 *  extension (apify ships LICENSE.md); the file must still exist and must still
 *  classify, so this changes only WHERE the gate looks, never whether it fires. */
const LICENSE_FILENAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING'];

/** The first root licence file that exists, or the canonical name so the error
 *  below names something recognisable. */
function rootLicensePath(repoPath: string): string {
  for (const n of LICENSE_FILENAMES) {
    const p = join(repoPath, n);
    if (existsSync(p)) return p;
  }
  return join(repoPath, 'LICENSE');
}

function readLicense(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read LICENSE at ${path}: ${(e as Error).message}`);
  }
}

/** Verifies a source's licence position and returns the allowlisted subtree
 *  prefixes (empty for whole-repo permissive sources). Throws to abort. */
function verifyLicense(src: SourceSpec, repoPath: string): { license: string; allow: string[] } {
  if (src.licenseMode === 'root') {
    const found = classifyLicense(readLicense(rootLicensePath(repoPath)));
    if (found !== src.expectLicense) {
      throw new Error(
        `[${src.key}] root LICENSE classified as ${found}, expected ${src.expectLicense} — aborting import.`,
      );
    }
    return { license: found, allow: [] };
  }

  // subtree-allowlist: the ROOT licence is expected NOT to be permissive, and
  // every allowlisted subtree must carry its own MIT LICENSE.
  const rootFound = classifyLicense(readLicense(rootLicensePath(repoPath)));
  if (rootFound !== 'Elastic-2.0') {
    throw new Error(
      `[${src.key}] root LICENSE classified as ${rootFound}; this source is configured as dual-licensed with an ` +
        `Elastic-2.0 root. Re-read its LICENSING.md and update SOURCES before importing.`,
    );
  }
  const allow = src.pathAllowlist || [];
  if (!allow.length) throw new Error(`[${src.key}] subtree-allowlist mode with an empty allowlist.`);
  for (const prefix of allow) {
    const sub = join(repoPath, prefix, 'LICENSE');
    const found = classifySubtreeLicense(readLicense(sub), prefix);
    if (found !== 'MIT') {
      throw new Error(`[${src.key}] subtree ${prefix}/LICENSE classified as ${found}, expected MIT — aborting import.`);
    }
  }
  return { license: 'MIT', allow };
}

/** Enforced on EVERY accepted file of an allowlisted source. Fail closed: a
 *  path outside the allowlist is a configuration bug, not a skippable file. */
function assertPathAllowed(src: SourceSpec, allow: string[], relPath: string): void {
  if (!allow.length) return;
  const posix = relPath.split(sep).join('/');
  const ok = allow.some((p) => posix === p || posix.startsWith(p + '/'));
  if (!ok) {
    throw new Error(
      `[${src.key}] refusing ${posix}: outside the MIT subtree allowlist (${allow.join(', ')}). ` +
        `Everything else in that repo is Elastic-2.0.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Commit SHA — read out of .git/ directly. No subprocess, no network.
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
// Category mapping — best-effort keyword match on the skill slug plus its
// description. Mirrors the spirit of the SkillCategory union in
// lib/skills/registry.ts, but harvested skills are a superset, so category here
// is a free-text label rather than a TS union member (kept to a fixed
// vocabulary: seo, ads, marketing, content, analytics, social, email,
// dev-tooling, ops, other). SkillCategory itself is NOT changed by this script.
// ---------------------------------------------------------------------------
const CATEGORY_RULES: { category: string; re: RegExp }[] = [
  { category: 'seo', re: /\bseo\b|serp|keyword|backlink|sitemap|hreflang|schema[- ]markup|\bgeo\b|\baeo\b|rank/ },
  { category: 'ads', re: /\bads?\b|\bppc\b|paid[- ]advertis|retarget|creative[- ]test|media[- ]plan/ },
  { category: 'social', re: /social|twitter|instagram|reddit|tiktok|linkedin|youtube|influencer/ },
  // `sequence` is NOT matched bare: it filed "fight scene and action sequence"
  // under email. In marketing prose the word only implies email when something
  // says so, so it must be qualified.
  { category: 'email', re: /email|newsletter|drip|\bsms\b|(email|drip|nurture|outreach|follow[- ]?up)[- ]sequence/ },
  { category: 'content', re: /content|copy|blog|video|image|deck|pptx|docx|xlsx|\bpdf\b|script|story|narrative|webinar|\bpr\b/ },
  { category: 'analytics', re: /analytic|\bga4\b|\bgsc\b|attribution|cohort|dashboard|report|metric|forecast|roi|funnel|\bcro\b/ },
  { category: 'dev-tooling', re: /browser|playwright|crawl|firecrawl|sitefetch|camoufox|scrape|connector|integration|\bapi\b|\bcrm\b|import|export|sync/ },
  { category: 'ops', re: /cron|agenthub|skill-creator|self-setup|onboard|memory|quality[- ]gate|eval|status|config|setup|help|validate/ },
  { category: 'marketing', re: /marketing|brand|campaign|persona|audience|positioning|launch|growth|lead|competitor|market/ },
];

/** Categories this harvester can emit. DERIVED from the rules above plus the
 *  'other' fallback, so a declared upstream category is validated against the
 *  real authority rather than a second hand-maintained list that could drift. */
const KNOWN_HARVEST_CATEGORIES = new Set<string>([...CATEGORY_RULES.map((r) => r.category), 'other']);

/** Slug evidence wins over description evidence — a description mentioning
 *  "email" in passing should not re-file a copywriting skill under `email`. */
function mapCategory(slug: string, description: string): string {
  const s = slug.toLowerCase().replace(/-/g, ' ');
  for (const rule of CATEGORY_RULES) if (rule.re.test(s)) return rule.category;
  const d = description.toLowerCase();
  for (const rule of CATEGORY_RULES) if (rule.re.test(d)) return rule.category;
  return 'other';
}

// ---------------------------------------------------------------------------
// Minimal YAML frontmatter parser — flat `key: value` pairs plus quoted-string
// values. Not a general YAML parser by design: this is a bounded, local,
// synchronous heuristic, not a dependency. Nested/indented lines are ignored.
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
// Per-source dialect handlers. Each one states exactly which upstream keys it
// reads and returns null when the shape does not match, so a malformed mapping
// is recorded as a skip instead of passing silently.
// ---------------------------------------------------------------------------
interface Meta {
  name: string;
  description: string;
  /** Only when the upstream frontmatter DECLARES one. An author's own label
   *  beats mapCategory()'s keyword inference, which is a fallback for sources
   *  that say nothing. Validated against the known set before use — an
   *  unrecognised upstream value is ignored, not trusted. */
  category?: string;
}

function readDialect(dialect: Dialect, attrs: Record<string, string>, dirName: string): Meta | null {
  switch (dialect) {
    // adclaw: `name` + `description`; `metadata:`/`license:`/`version:` blocks
    // and `allowed-tools` are dropped (they do not map onto Skill).
    case 'adclaw': {
      if (!attrs.name && !attrs.title) return null;
      const name = (attrs.name || attrs.title).trim();
      const description = (attrs.description || '').trim();
      if (!name) return null;
      return { name, description };
    }
    // digital-marketing-pro: `name` + `description`, where description embeds
    // the trigger phrases. `argument-hint`, `user-invocable`,
    // `disable-model-invocation`, `allowed-tools`, `view-preference`,
    // `engagement-part` and `effort` are CLI-bound and dropped. `triggers`,
    // when present, is folded into the description because Hermes reads
    // description for relevance.
    case 'dmp': {
      const name = (attrs.name || '').trim();
      if (!name) return null;
      let description = (attrs.description || '').trim();
      const triggers = (attrs.triggers || '').trim();
      if (triggers) description = description ? `${description} Triggers: ${triggers}.` : `Triggers: ${triggers}.`;
      return { name, description };
    }
    // kai-cmo-harness: strictly `name` + `description`, nothing else.
    case 'kai': {
      const name = (attrs.name || '').trim();
      const description = (attrs.description || '').trim();
      if (!name || !description) return null;
      return { name, description };
    }
    // marketing-os-starter: `name` + `description`; the dir name is the slug.
    case 'mos': {
      const name = (attrs.name || dirName).trim();
      const description = (attrs.description || '').trim();
      if (!name || !description) return null;
      return { name, description };
    }
    // marketing-os-arsenal group: `name` + `description`, same two keys as
    // 'mos'. Kept as a SEPARATE dialect rather than reusing that one because
    // these are eight independent repos with no shared upstream convention —
    // folding them into an existing case would mean a future shape change in
    // any one of them silently parses as marketing-os-starter.
    //
    // Additionally reads `category` where an author declares it (advertising-ops
    // does). `allowed-tools`, `type`, `version` and `metadata` are CLI/packaging
    // concerns and are dropped, matching every other dialect here.
    case 'arsenal': {
      const name = (attrs.name || dirName).trim();
      const description = (attrs.description || '').trim();
      if (!name || !description) return null;
      const declared = (attrs.category || '').trim().toLowerCase();
      return declared ? { name, description, category: declared } : { name, description };
    }
  }
}

// ---------------------------------------------------------------------------
// Strip CLI-bound content. A LeadRail skill is a prompt module, not an
// executable: anything that assumes Claude Code's shell, slash-command
// namespace, hook system or plugin manifest is removed. Deliberately narrow and
// auditable — it does not attempt to rewrite prose.
// ---------------------------------------------------------------------------
const SHELL_FENCE = /^```(bash|sh|shell|zsh|console|powershell|ps1)\b[\s\S]*?^```[ \t]*$/gim;
const PLUGIN_MANIFEST_LINE = /^.*\b(plugin\.(json|yaml)|\.claude\/hooks?\/|hooks\.json|settings\.json\.example|gemini-extension\.json)\b.*$/gim;
const SLASH_COMMAND = /(^|[\s(`"'[])\/([a-z][a-z0-9-]*:)?([a-z][a-z0-9-]{2,})\b/gim;

function stripCliBound(body: string): { text: string; strips: Record<string, number> } {
  const strips: Record<string, number> = { shellBlocks: 0, manifestLines: 0, slashCommands: 0 };
  let out = body.replace(SHELL_FENCE, () => {
    strips.shellBlocks++;
    return '';
  });
  out = out.replace(PLUGIN_MANIFEST_LINE, () => {
    strips.manifestLines++;
    return '';
  });
  // `/digital-marketing-pro:seo-audit` → `seo-audit`; `/kai-partnership` →
  // `kai-partnership`. Leaves real paths (`harness/…`) and URLs untouched
  // because those never match a bare leading slash at a token boundary.
  out = out.replace(SLASH_COMMAND, (m, lead: string, ns: string | undefined, cmd: string) => {
    if (/^(https?|mailto)$/i.test(cmd)) return m;
    strips.slashCommands++;
    return `${lead}${cmd}`;
  });
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, strips };
}

// ---------------------------------------------------------------------------
// Quality/security scan — REGEX/STRING HEURISTICS ONLY.
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

// Values that LOOK like a secret assignment but are documentation. A skill that
// tells the reader to `export PROSPEO_API_KEY="your_api_key_here"` is teaching
// setup, not leaking a key, and refusing it costs a real skill for nothing.
//
// This is a RULE, not a list of exceptions. Growing a list per file is how a
// scanner quietly becomes "whatever lets today's import through" — so the test
// is a property of the VALUE, and it is deliberately narrow:
//
//   1. the whole value is lowercase words joined by _ - . or spaces, and
//   2. it contains a word that announces itself as a stand-in.
//
// A real credential fails (1) almost always: keys carry mixed case, digit runs,
// or a vendor prefix like `sk-`/`AKIA`. Anything that fails either test still
// trips the scanner and is still refused — the fail-closed default is intact,
// and the openai-style and AWS detectors are untouched by this at all.
const PLACEHOLDER_WORDS = [
  'your', 'yours', 'my', 'example', 'sample', 'placeholder', 'changeme',
  'change', 'dummy', 'fake', 'test', 'insert', 'replace', 'todo', 'here',
  'xxx', 'xxxx', 'abc123', 'redacted', 'none',
];

/** True when a secret-shaped VALUE is self-evidently a stand-in. */
function isPlaceholderValue(raw: string): boolean {
  const val = raw.toLowerCase().replace(/[<>{}[\]()]/g, '').trim();
  // (1) lowercase words only — no mixed case, no vendor-prefixed key shapes.
  if (!/^[a-z0-9]+([_\-. ][a-z0-9]+)*$/.test(val)) return false;
  // Long unbroken alphanumeric runs are entropy, not prose.
  if (/[a-z0-9]{17,}/.test(val)) return false;
  // (2) at least one token that announces itself as a stand-in.
  const words = val.split(/[_\-. ]+/);
  return words.some((w) => PLACEHOLDER_WORDS.includes(w));
}

/** True when EVERY secret-shaped hit for `re` in `body` is a placeholder. One
 *  unrecognised value and the flag stands for the whole file. */
function allHitsArePlaceholders(body: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const hits = body.match(g);
  if (!hits || !hits.length) return false;
  return hits.every((h) => {
    const m = h.match(/["']([^"']+)["']/);
    return isPlaceholderValue(m ? m[1] : h);
  });
}

function scanQuality(body: string): string[] {
  const flags: string[] = [];
  for (const p of SECRET_PATTERNS) {
    if (!p.re.test(body)) continue;
    if (allHitsArePlaceholders(body, p.re)) continue;
    flags.push(`secret:${p.name}`);
  }
  for (const p of DESTRUCTIVE_PATTERNS) if (p.re.test(body)) flags.push(`destructive:${p.name}`);
  if (body.trim().length < MIN_BODY_LENGTH) flags.push('too-short');
  return flags;
}

function slugify(name: string, dirName: string): string {
  const base = (name || dirName).toLowerCase().trim();
  return (
    base
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || dirName.toLowerCase()
  );
}

// ---------------------------------------------------------------------------
// Types (mirrored into lib/skills/harvested.ts)
// ---------------------------------------------------------------------------
interface HarvestedSkillRaw {
  slug: string;
  name: string;
  description: string;
  category: string;
  instructions: string;
  source: string;
  sourceRepo: string;
  sourceCommit: string;
  sourcePath: string;
  license: string;
  inspiredBy: string;
}

function walkSkillFiles(root: string, acc: string[] = [], depth = 0): string[] {
  if (depth > 6) return acc;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const full = join(root, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkSkillFiles(full, acc, depth + 1);
    // Case-INSENSITIVE: upstreams disagree on casing (graphify ships skill.md,
    // everyone else SKILL.md). Still an exact filename match — nothing else is
    // collected — so this widens which files are FOUND, never what counts as a
    // skill. The frontmatter parser and the per-source dialect remain the gate.
    else if (entry.toLowerCase() === 'skill.md') acc.push(full);
  }
  return acc;
}

interface SourceStats {
  key: string;
  commit: string;
  license: string;
  found: number;
  accepted: number;
  skipped: { path: string; reason: string }[];
  strips: Record<string, number>;
}

function main() {
  const startedAt = Date.now();

  if (!existsSync(HARVEST_ROOT)) {
    throw new Error(
      `Clone root not found: ${HARVEST_ROOT}\n` +
        `Pass it as argv[2] or set HARVEST_ROOT. It must be OUTSIDE this git tree — vendored upstream source is never committed.`,
    );
  }
  if (!relative(REPO_ROOT, HARVEST_ROOT).startsWith('..')) {
    throw new Error(`Clone root ${HARVEST_ROOT} is inside the repo tree. Clone upstreams outside ${REPO_ROOT}.`);
  }

  const stats: SourceStats[] = [];
  // slug -> entry, for cross-source and within-source dedupe.
  const bySlug = new Map<string, HarvestedSkillRaw>();
  const priorityOf = new Map<string, number>();
  const dedupeLosers: { slug: string; lost: string; won: string }[] = [];

  for (const src of SOURCES) {
    const repoPath = join(HARVEST_ROOT, src.dir);
    if (!existsSync(repoPath)) {
      throw new Error(`[${src.key}] clone missing at ${repoPath} — clone all four sources before harvesting.`);
    }
    const { license, allow } = verifyLicense(src, repoPath);
    const commit = readGitSha(repoPath);
    console.log(`[harvest-skills] ${src.key}: licence ${license}${allow.length ? ` (subtrees: ${allow.join(', ')})` : ''} @ ${commit.slice(0, 12)}`);

    const stat: SourceStats = { key: src.key, commit, license, found: 0, accepted: 0, skipped: [], strips: {} };

    const files: string[] = [];
    for (const rootRel of src.skillRoots) walkSkillFiles(join(repoPath, rootRel), files);
    files.sort();

    for (const file of files) {
      const relPath = relative(repoPath, file);
      // Per-file licence enforcement — fail closed.
      assertPathAllowed(src, allow, relPath);
      stat.found++;

      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch (e) {
        stat.skipped.push({ path: relPath, reason: `read-error: ${(e as Error).message}` });
        continue;
      }

      let parsed: ReturnType<typeof parseFrontmatter>;
      try {
        parsed = parseFrontmatter(raw);
      } catch (e) {
        stat.skipped.push({ path: relPath, reason: `parse-error: ${(e as Error).message}` });
        continue;
      }
      if (!parsed) {
        stat.skipped.push({ path: relPath, reason: 'no-frontmatter' });
        continue;
      }

      const dirName = relPath.split(sep).slice(-2)[0] || 'skill';
      const meta = readDialect(src.dialect, parsed.attrs, dirName);
      if (!meta) {
        stat.skipped.push({ path: relPath, reason: `dialect-mismatch (${src.dialect})` });
        continue;
      }

      const { text: bodyTrimmed, strips } = stripCliBound(parsed.body);
      for (const [k, v] of Object.entries(strips)) stat.strips[k] = (stat.strips[k] || 0) + v;

      const flags = scanQuality(bodyTrimmed);
      if (flags.includes('too-short')) {
        stat.skipped.push({ path: relPath, reason: `too-short (<${MIN_BODY_LENGTH} chars body)` });
        continue;
      }
      const secretFlags = flags.filter((f) => f.startsWith('secret:'));
      if (secretFlags.length) {
        stat.skipped.push({ path: relPath, reason: `secret-pattern: ${secretFlags.join(',')}` });
        continue;
      }
      const destructiveFlags = flags.filter((f) => f.startsWith('destructive:'));
      if (destructiveFlags.length) {
        stat.skipped.push({ path: relPath, reason: `destructive-shell: ${destructiveFlags.join(',')}` });
        continue;
      }

      const slug = slugify(meta.name, dirName);
      const posixPath = relPath.split(sep).join('/');
      const entry: HarvestedSkillRaw = {
        slug,
        name: meta.name,
        description: meta.description || `Imported skill: ${meta.name}`,
        // An author's own label wins, but only if it is a category this catalog
        // actually has. Anything else falls back to inference rather than
        // inventing a bucket nothing can filter on.
        category: meta.category && KNOWN_HARVEST_CATEGORIES.has(meta.category)
          ? meta.category
          : mapCategory(slug, meta.description),
        instructions: bodyTrimmed,
        source: src.key,
        sourceRepo: src.repo,
        sourceCommit: commit,
        sourcePath: posixPath,
        license,
        inspiredBy: `${src.repo}@${commit.slice(0, 12)} — ${posixPath}`,
      };

      // Dedupe: prefer the more specific (longer) instruction body; on a tie,
      // the lower-priority source wins. Records which source won.
      const existing = bySlug.get(slug);
      if (existing) {
        const incomingWins =
          entry.instructions.length > existing.instructions.length ||
          (entry.instructions.length === existing.instructions.length &&
            src.priority < (priorityOf.get(slug) ?? Number.MAX_SAFE_INTEGER));
        if (incomingWins) {
          dedupeLosers.push({ slug, lost: `${existing.source}:${existing.sourcePath}`, won: `${src.key}:${posixPath}` });
          bySlug.set(slug, entry);
          priorityOf.set(slug, src.priority);
          stat.accepted++;
        } else {
          dedupeLosers.push({ slug, lost: `${src.key}:${posixPath}`, won: `${existing.source}:${existing.sourcePath}` });
        }
        continue;
      }
      bySlug.set(slug, entry);
      priorityOf.set(slug, src.priority);
      stat.accepted++;
    }

    stats.push(stat);
  }

  const results = Array.from(bySlug.values()).sort((a, b) => a.slug.localeCompare(b.slug));

  // -------------------------------------------------------------------------
  // Emit lib/skills/harvested.ts
  // -------------------------------------------------------------------------
  const perSource = new Map<string, number>();
  for (const r of results) perSource.set(r.source, (perSource.get(r.source) || 0) + 1);
  const provenanceLines = SOURCES.map((s) => {
    const st = stats.find((x) => x.key === s.key)!;
    return `//   - ${s.repo} (${st.license}) @ ${st.commit} — ${perSource.get(s.key) || 0} skills`;
  }).join('\n');

  const header = `// AUTO-GENERATED by scripts/harvest-skills.ts — DO NOT EDIT BY HAND.
// Regenerate with: HARVEST_ROOT=<clone-dir> npx tsx scripts/harvest-skills.ts
//
// Sources (all permissively licensed; see the root NOTICE file):
${provenanceLines}
//
// kai-cmo-harness is dual-licensed: only its MIT subtrees are read, enforced
// per file by the harvester's path allowlist. Nothing under an Elastic-2.0
// path is imported.
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
  /** Short source key, e.g. 'adclaw'. */
  source: string;
  /** Upstream repo, e.g. 'Citedy/adclaw'. */
  sourceRepo: string;
  /** Upstream commit SHA this content was harvested from. */
  sourceCommit: string;
  /** Repo-relative path of the upstream SKILL.md. */
  sourcePath: string;
  license: string;
  inspiredBy: string;
}

export const HARVESTED_SKILLS: HarvestedSkill[] = ${JSON.stringify(results, null, 2)};
`;
  writeFileSync(OUTPUT_FILE, header, 'utf8');

  // -------------------------------------------------------------------------
  // Emit this script's OWN section of the root NOTICE (Apache-2.0 §4
  // attribution for adclaw; the MIT sources are listed too so the
  // attribution file is the single place to look) — see scripts/lib/notice.ts
  // for why this is a named section, not a wholesale file write: a wholesale
  // write here used to silently drop harvest-personas.ts's own section on
  // every re-run (BACKLOG 5c).
  // -------------------------------------------------------------------------
  const noticeSources = SOURCES.map((s) => {
    const st = stats.find((x) => x.key === s.key)!;
    return `${s.repo}
  License:   ${st.license}${s.licenseMode === 'subtree-allowlist' ? ' (MIT subtrees only; the rest of that repo is Elastic-2.0 and is NOT used)' : ''}
  Commit:    ${st.commit}
  Used for:  ${perSource.get(s.key) || 0} normalised skill entries in lib/skills/harvested.ts
  Notes:     ${s.requiresNotice ? 'Apache-2.0 §4 attribution — see the copyright line in the section above.' : 'MIT — attribution retained here as a courtesy and audit trail.'}`;
  }).join('\n\n');

  const skillsSection = `--------------------------------------------------------------------------------
Skill content (scripts/harvest-skills.ts -> lib/skills/harvested.ts)
--------------------------------------------------------------------------------

No upstream source code is executed, imported, or distributed for these
sources — only normalised markdown prompt modules.

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

  Skill content from src/adclaw/agents/skills/*/SKILL.md was modified:
  frontmatter was normalised onto LeadRail's skill schema and CLI-bound
  content (shell blocks, slash commands, plugin-manifest references) was
  removed.

--------------------------------------------------------------------------------
All sources
--------------------------------------------------------------------------------

${noticeSources}

--------------------------------------------------------------------------------
Excluded on licence grounds
--------------------------------------------------------------------------------

  cgallic/kai-cmo-harness — everything outside harness/, knowledge/, docs/,
    plugins/, scripts/quality_gates/ and scripts/reddit_monitor/ is
    Elastic License 2.0 and is NOT used. That includes legacy/, app-meetkai/,
    daemon/, agent/, gateway/, kai/, lib/, tools/, bin/, deploy/, evals/,
    site/, prod-static/ and the rest of scripts/.
  helio, Synapsr/fromHello — AGPL-3.0. Not used.
  inbharatai/SocialFlow — no licence. Not used.`;
  writeNoticeSection('SKILLS', skillsSection);

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  const elapsedMs = Date.now() - startedAt;
  let totalFound = 0;
  let totalSkipped = 0;
  for (const st of stats) {
    totalFound += st.found;
    totalSkipped += st.skipped.length;
    console.log(
      `[harvest-skills] ${st.key}: found ${st.found}, kept ${perSource.get(st.key) || 0}, skipped ${st.skipped.length}, strips ${JSON.stringify(st.strips)}`,
    );
    for (const s of st.skipped) console.log(`    - ${s.path}: ${s.reason}`);
  }
  console.log(`[harvest-skills] SKILL.md found across sources: ${totalFound}`);
  console.log(`[harvest-skills] skipped (malformed/quality): ${totalSkipped}`);
  console.log(`[harvest-skills] deduped away: ${dedupeLosers.length}`);
  const withinKai = dedupeLosers.filter((d) => d.lost.startsWith('kai-cmo-harness') && d.won.startsWith('kai-cmo-harness')).length;
  console.log(`[harvest-skills]   of which within kai-cmo-harness (skills vs skills-v2): ${withinKai}`);
  console.log(`[harvest-skills]   cross-source: ${dedupeLosers.length - withinKai}`);
  console.log(`[harvest-skills] FINAL unique skills: ${results.length}`);
  console.log(`[harvest-skills] wrote ${OUTPUT_FILE}`);
  console.log(`[harvest-skills] wrote NOTICE (SKILLS section)`);
  console.log(`[harvest-skills] done in ${elapsedMs}ms`);
}

main();

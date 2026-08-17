# PACKET 5.1 — Skills harvest (re-scoped, unblocked)

**Tier:** C (bulk, additive) · **Branch:** `feat/copilot-remediation` · **Depends on:** nothing.

Previously blocked: "clones missing". **Unblocked 2026-08-16** — upstream
coordinates re-verified, see `OSS_INTEGRATION_PLAN.md` §1a.

---

## The gap

`lib/skills/registry.ts` holds **18** curated skills. Four permissively-licensed
upstreams carry **≈405 unique** marketing skills between them. Hermes already
selects skills per request and `loadEnabledSkillsForAgent` already injects them
into both agent loops — the machinery works, it is just starved of content.

This packet is content, not architecture. It must not change how skills are
selected, injected, or rendered.

## Sources (all verified 2026-08-16)

| Repo | License | `SKILL.md` | Take |
|---|---|---|---|
| `indranilbanerjee/digital-marketing-pro` | MIT | 163 | `skills/`, `agents/` |
| `Citedy/adclaw` | Apache-2.0 | 122 | `src/adclaw/agents/skills/` |
| `cgallic/kai-cmo-harness` | MIT subset | ~115 unique | **`harness/` and `knowledge/` ONLY** |
| `ericosiu/marketing-os-starter` | MIT | 5 | skills + agent defs |

**Licensing is a gate, not a formality.**

- kai-cmo-harness is dual-licensed. MIT covers `harness/`, `knowledge/`, `docs/`,
  `plugins/`, `scripts/quality_gates/`, `scripts/reddit_monitor/`. **Everything
  else is Elastic-2.0 and must not be copied** — `app-meetkai/`, `daemon/`,
  `agent/`, `gateway/`, `kai/`, `lib/`, `tools/`, `bin/`, `deploy/`, `evals/`,
  `site/`, `prod-static/`, `legacy/`, and the rest of `scripts/`. Read its
  `LICENSING.md` first and follow it, not this summary.
- `harness/` and `plugins/` in that repo are the same skills materialised twice.
  Take `harness/` and skip `plugins/`, or the dedupe pass will do double work.
- adclaw is Apache-2.0 and therefore requires **attribution**: a `NOTICE` file.
- Do NOT clone helio, socialflow, or fromHello. AGPL / no-license / no code.

## ⚠ AMENDED 2026-08-16 — most of this is already built

**`scripts/harvest-skills.ts` already exists (260 lines) and does most of the
job.** Read it before writing anything. It already implements:

- a **licence gate** that aborts the whole import unless the source `LICENSE` is
  Apache-2.0 or MIT (`verifyLicense()`)
- a `SKILL.md` **frontmatter parser** (`parseFrontmatter`)
- a **category mapper** onto the existing `SkillCategory` union (`mapCategory`)
- a **secret / destructive-pattern scan** over each body (`SECRET_PATTERNS`,
  `DESTRUCTIVE_PATTERNS`, `scanQuality`)
- slugification, a `MIN_BODY_LENGTH` floor, skip-don't-fail on a malformed file
- emission of `lib/skills/harvested.ts` with **provenance already modelled**:
  `HarvestedSkill` carries `source`, `license`, and `inspiredBy`

It is pure, offline, synchronous — no network, no LLM, no subprocesses. Keep it
that way.

**Do NOT create `lib/skills/normalize.ts`.** That would fork a working
normalizer. **Extend this script instead.** What it actually lacks:

1. `SOURCE_ROOT` is hardcoded to `/home/.z/workspaces/.../oss-repos/adclaw` — a
   path that no longer exists. Parameterise it (argv or env), defaulting to a
   scratch clone dir outside the git tree.
2. **Single-source only.** It handles adclaw's frontmatter dialect alone. The
   other three upstreams use different shapes (digital-marketing-pro declares
   slug / triggers / reads / produces / gate; kai-cmo-harness differs again).
   Handle each source explicitly — do not widen one loose parser to cover all
   four, or a malformed mapping will pass silently.
3. **No cross-source dedupe.** Required now that four repos overlap.
4. **No per-path licence restriction.** `verifyLicense()` checks ONE root
   `LICENSE` file. That is correct for adclaw and dmp, and **wrong and unsafe for
   kai-cmo-harness**, whose root `LICENSE` is Elastic-2.0 with MIT applying only
   to specific subtrees. A root-level check there would either abort the import
   or, worse, wave through Elastic-licensed content. That repo needs a path
   allowlist (`harness/`, `knowledge/`, `docs/`, `plugins/`,
   `scripts/quality_gates/`, `scripts/reddit_monitor/`) enforced per file.
5. **No `NOTICE` file emission** for adclaw's Apache attribution.

## Files

**Modify:** `scripts/harvest-skills.ts` (extend — see above),
`lib/skills/registry.ts` (extend the catalog only — do not change its types or
selection logic)
**Regenerate:** `lib/skills/harvested.ts` (auto-generated; never hand-edit)
**Create:** `NOTICE`, and a `lib/skills/library/` staging tree only if the
extended script genuinely needs one

Clone upstreams to a scratch directory **outside the git tree**. Never commit
vendored repo source; only the normalised skill content lands in the repo.

## Steps

1. **Clone the four repos to scratch.** Record each commit SHA — provenance goes
   in the normalised output so a skill can be traced to its source.

2. **Write `lib/skills/normalize.ts`.** Maps upstream `SKILL.md` frontmatter onto
   LeadRail's existing `Skill` interface in `lib/skills/registry.ts`. Read that
   interface first and conform to it — `{ id, name, category, when, systemModule }`
   plus whatever else it declares. Do not widen the type to fit the sources; drop
   fields that do not map. The upstream schemas differ (dmp uses slug/triggers/
   reads/produces/gate; adclaw uses its own), so handle each source explicitly
   rather than with one loose parser.

3. **De-dupe.** Across sources, and within kai-cmo-harness. Same-title skills
   from different upstreams are common. Prefer the more specific/longer
   `systemModule`; record which source won.

4. **Strip CLI-bound content.** Slash commands, hooks, plugin manifests, file-path
   references, and `bash`/tool invocations that assume Claude Code's environment.
   A LeadRail skill is a prompt module, not an executable.

5. **Attribution.** A root `NOTICE` naming adclaw (Apache-2.0) with its copyright
   line, plus per-skill provenance in the normalised entries.

6. **Extend the catalog.** Keep the existing 18 curated entries as-is. Added
   entries must not change `SkillCategory` semantics — map into the existing
   categories (`claude`, `marketing`, `linkedin`, `outreach`, `lead-gen`,
   `humanizer`) or, if a genuinely new category is unavoidable, add it and say so
   in the report.

## Hard constraints

- **Content only.** No upstream code is executed or imported. `lib/skills/registry.ts`'s
  header comment explains why (this app holds the service-role key and customer
  lead data); that policy stands and is the reason this is a content harvest.
- **No auto-update mechanism.** adclaw pulls skills from a remote Skills Hub at
  runtime. Do not reproduce that. Adding a skill must remain "add a typed entry,
  reviewable in one diff".
- Do not touch `lib/ai/hermes.ts`, `lib/skills/store.ts`, or either agent loop.
  Selection and injection already work.
- Watch prompt budget: `toolCatalogForPrompt()` and the skills block both feed
  the system prompt. 400 skills must NOT all be injected at once — Hermes selects
  a handful per request. Confirm the injection path is selection-gated before
  bulk-loading, and if it is not, **STOP and report** rather than shipping a
  system prompt that blows the context window.

## Acceptance criteria

1. `./node_modules/.bin/tsc --noEmit` and `npm run build` pass.
2. The registry's existing 18 entries are byte-identical.
3. Every added skill carries provenance (source repo + commit SHA) and a
   license-compatible origin. Zero entries originate from an Elastic-2.0,
   AGPL, or unlicensed path.
4. `NOTICE` exists and names adclaw.
5. The system prompt does not grow with catalog size — verify a single request's
   injected skills block is still bounded.

## Reviewer checklist (human — do not self-certify)

- [ ] Spot-check 5 imported skills against their upstream `SKILL.md` for fidelity.
- [ ] Confirm no file under a kai-cmo-harness Elastic-2.0 path was copied.
- [ ] Confirm `NOTICE` satisfies Apache-2.0 §4 for adclaw.
- [ ] Confirm no vendored upstream source is committed — only normalised content.
- [ ] Confirm the skills block injected per request is still small.

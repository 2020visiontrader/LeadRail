# LeadRail — OSS Harvest & Remodel Plan

Status: PLAN / awaiting go · Date: 2026-08-13 · Method: research done (11 repos studied), execution delegated to Sonnet.

This is the source of truth for what LeadRail takes from the studied open-source marketing repos, and how it remodels around them. Clones live **outside** the LeadRail git tree at `/home/.z/workspaces/con_rf0cG0dud6GVzG4C/oss-repos/` on purpose (AGPL/no-license contamination risk — see §Licensing).

---

## 0. TL;DR decisions

1. **Do NOT adopt any repo wholesale.** LeadRail's CRM/outbound/agent spine is already ahead of every one of these. This is a *harvest + remodel*, not a migration.
2. **Do NOT copy code from helio, socialflow, or fromHello.** helio = AGPL-3.0 (copying forces LeadRail open-source), socialflow = no license (all-rights-reserved), fromHello = **zero code** (waitlist landing page, source not published until "GA Q3 2026"). helio is inspiration-only; its capabilities get clean-roomed.
3. **Frontend: adopt adclaw's *visual language* inside LeadRail's existing Tailwind stack** — do NOT rip out Tailwind for Ant Design. Update `DESIGN.md` to the new canonical system.
4. **Biggest immediate win = skills content harvest** (~350 permissively-licensed marketing skills + 24 agent roles). Additive, reversible, zero risk to existing code.

---

## 1. Licensing gate (decides everything)

| Repo | Upstream | License | Code reuse in commercial LeadRail? |
|------|----------|---------|-------------------------------------|
| adclaw | `Citedy/adclaw` | Apache-2.0 | ✅ Yes (design + skills content + patterns) |
| opensoul | `iamevandrake/opensoul` | MIT | ✅ Yes |
| pendpost | `pendpost/pendpost` | MIT | ✅ Yes |
| MARA | `KEITH-GJINO/MARA` | MIT | ✅ Yes (patterns only; agents are stubs) |
| digital-marketing-pro | `indranilbanerjee/digital-marketing-pro` | MIT | ✅ Yes (163 skills + 24 agents) |
| marketing-os-starter | `ericosiu/marketing-os-starter` | MIT | ✅ Yes (frameworks/hooks) |
| kai-cmo-harness | `cgallic/kai-cmo-harness` | MIT (plugin/knowledge) + **Elastic-2.0** (hosted infra) | ⚠️ MIT subset only — see §1a |
| evc | **not located** | MIT | ⚠️ Skip — CLI-bound prompt bundles, low ROI |
| helio | **not located** | **AGPL-3.0** | ❌ Inspiration only, no code |
| socialflow | `inbharatai/SocialFlow` | **None** | ❌ No code |
| fromHello | `Synapsr/fromHello` | AGPL-3.0 | ❌ No code exists |

### 1a. Verification log — 2026-08-16

Upstream coordinates and licences re-confirmed directly against GitHub (the
original clones at `/home/.z/workspaces/.../oss-repos/` are gone, which is what
blocked packet 5.1). Corrections to the original research:

- **`SKILL.md` counts are higher than estimated.** Measured via the git trees
  API: adclaw **122**, digital-marketing-pro **163**, kai-cmo-harness **245**
  (229 inside MIT subtrees), marketing-os-starter **5**.
- **kai-cmo-harness is ~2x what §2d recorded** (it said 57 skills). Its
  `harness/` (115) and `plugins/` (114) trees are the SAME skills materialised
  twice — the installer copies `harness/` into `plugins/` — so treat unique as
  **~115**, not 229. `legacy/` (16) is ELv2 and excluded.
- **Its MIT map is broader than recorded here.** Per its own `LICENSING.md`, MIT
  covers `harness/`, `knowledge/`, `docs/`, `plugins/`,
  `scripts/quality_gates/`, `scripts/reddit_monitor/`. The generating rule is
  "anything the plugin or `install.sh` copies onto a user's machine is MIT".
  Elastic-2.0 governs everything else — the §1 skip list is correct and extends
  to `lib/`, `tools/`, `bin/`, `deploy/`, `evals/`, `site/`, `prod-static/` and
  the rest of `scripts/`. It explicitly permits redistributing modified skills
  "including inside a paid product of your own", which is exactly this use.
- **Realistic harvest ≈ 405 unique permissive skills** before cross-repo dedupe,
  against the ~350 estimated in §2d. LeadRail's registry currently has 18.
- **fromHello still has zero code** — 26 KB, no detected language, last push
  2026-06-01, contents are README/LICENSE/CONTRIBUTING/SECURITY/assets. The §0
  assessment holds unchanged.
- **helio and evc could not be located.** Both names collide with far more
  popular unrelated projects. This costs nothing: helio was already
  inspiration-only (AGPL-3.0 would force LeadRail open-source) and its journey
  DAG is meant to be clean-roomed per §2c; evc is already marked skip. Drop both
  from the roster unless the original URLs resurface.
- **adclaw lineage:** it derives from CoPaw by AgentScope, and its skills
  auto-update from a Skills Hub. Harvest the markdown CONTENT only — never the
  auto-update mechanism. See the supply-chain note at the top of
  `lib/skills/registry.ts`, which already states this policy.

---

## 2. What LeadRail takes, by area

### 2a. Frontend remodel (from adclaw — Apache)
Adopt adclaw's **look**, not its library. Update `DESIGN.md` → new canonical system that keeps the current "operator console" density/structure but restyles to:
- **Palette:** slate scale (`#0f172a`→`#f8fafc`) neutral base; **primary `#615CED`** (indigo); keep semantic success/warn/error.
- **Surfaces:** glassmorphism cards — soft gradient bg, `backdrop-filter: blur(8px)`, 16px radius, layered shadows.
- **Controls:** pill buttons (full radius), medium-high density.
- **Chat console (the centrepiece):** persona pill-tabs across the top → streaming message list → bottom input with @-persona mention chip bar → **live progress pulse** (animated dot + "X is working" + elapsed timer; stages thinking→tools→writing→error).
- Reference files: `oss-repos/adclaw/console/src/pages/Chat/index.tsx` (stream-event classification logic, ~lines 960–1245), `console/src/layouts/*`, `console/src/styles/citedy-overrides.less`.
- **Port target:** LeadRail's existing `/assistant` console + thinking-steps UI. Reuse the SSE event-classification strategy (thinking/tools/writing/error) to drive richer tool + reasoning rendering. Rebuild in Tailwind/React — do not import Ant Design.

### 2b. Agentic layer upgrades (LeadRail already has: ReAct loop, tool registry, LLM router, MCP server, memory, capability-registry-in-design)
- **Multi-persona + coordinator (from adclaw):** persona = `{id, name, SOUL/system-prompt, model, skills[]}`; @-mention routing; one `is_coordinator` persona runs synthesis across delegated personas. Maps onto LeadRail's per-venture persona module. Ref: `adclaw/src/adclaw/agents/persona_manager.py`, `coordinator/synthesis.py`.
- **Typed approval lifecycle (from opensoul — MIT):** states `pending → approved / rejected / revision_requested`, actor tracking (`requestedByAgentId` vs `decidedByUserId`), **payload redaction** (strip secrets before UI), and **heartbeat wakeup** (agent proceeds only on approval). Ref: `opensoul/server/src/routes/approvals.ts`, `ui/src/components/ApprovalCard.tsx`. Upgrades LeadRail's existing approval gate.
- **No-self-approval rule + data-layer enforcement (from pendpost — MIT):** approval is a real field on the record, not a permission check; content edit invalidates prior approval; scheduler only runs `approved`. Plus their **API=MCP parity test** pattern. Ref: `pendpost/lib/writes.mjs` (~976–1050), `test/parity-check.mjs`.
- **Pipeline DAG (from MARA/socialflow patterns):** evolve `lib/sequences.ts` toward `depends_on` + conditional stages; adopt socialflow's Reviewer-gate idea (regex credential/PII + brand-voice scan returning approved/review/blocked) as a LeadRail content quality gate. socialflow = pattern only (no license).
- **Per-account LLM key vault (clean-room from helio concept):** org-scoped provider override (AES-GCM encrypted), env default → org key. Concept only; write fresh.

### 2c. Journey builder (the real functional gap — clean-room from helio concept)
helio's visual journey DAG (branch / A-B split / wait-for-event / webhook / goal nodes) is the biggest capability LeadRail lacks vs commercial CRMs. **Design fresh** as the evolution of `lib/sequences.ts`; do not read/copy helio's AGPL code — the concept is well-known.

### 2d. Skills & agent-role content harvest (HIGHEST ROI, do first)
Import into LeadRail's `lib/skills/registry.ts` as markdown + prompt assets:
- **digital-marketing-pro (MIT):** 163 SKILL.md (Agent Skills standard) + 24 agent role defs + 12-part methodology + compliance framework. `oss-repos/digital-marketing-pro/skills/`, `/agents/`.
- **kai-cmo-harness (MIT subset):** 57 skills + 67 playbooks + 37 checklists + 38 frameworks + quality gates. `oss-repos/kai-cmo-harness/harness/skills/`, `knowledge/`, `scripts/quality_gates/`.
- **adclaw (Apache):** 125 SKILL.md (ads/seo/content/social) + the SKILL.md frontmatter schema. `oss-repos/adclaw/src/adclaw/agents/skills/`.
- **marketing-os-starter (MIT):** 6 hook formulas + 7 growth playbooks + 3-segment activation.
- Total ≈ **350+ marketing skills**, all permissive. De-dupe, normalize frontmatter to LeadRail's registry schema, strip CLI-specific bits (slash commands, hooks).

---

## 3. Sonnet execution plan (phased, branch `feat/oss-harvest-remodel`)

**Phase 0 — safe & additive (no existing code touched):**
- Copy permissive skill content into a new `lib/skills/library/` staging tree; write a normalizer that maps SKILL.md frontmatter → LeadRail registry entries. De-dupe across sources. Attribution/NOTICE file for Apache (adclaw).

**Phase 1 — design system:**
- Rewrite `DESIGN.md` to the new canonical tokens (§2a). Add tokens to `tailwind.config.js` + `app/globals.css`. Build 2–3 restyled reference components (card, button, chat bubble) to prove the look before mass application.

**Phase 2 — chat console remodel:**
- Level up `/assistant` to the persona-tab + live-progress-pulse pattern using the SSE event-classification strategy from adclaw (reimplemented in TS/Tailwind).

**Phase 3 — agent upgrades:**
- Approval lifecycle → opensoul's typed states + revision + redaction + no-self-approval (pendpost). Multi-persona coordinator/synthesis. Content quality-gate (socialflow pattern).

**Phase 4 — journey builder (clean-room):**
- Visual DAG evolution of `lib/sequences.ts`.

Each phase: typecheck + build before the next. Sonnet executes edits; review each phase diff against this doc before proceeding.

---

## 4. Open decisions (blocking Sonnet on code)
1. **License stance:** confirm clean-room only for helio/socialflow/fromHello (no code copy). [Recommended: yes]
2. **Frontend:** adclaw look inside LeadRail's Tailwind, NOT an Ant Design swap. [Recommended: yes]
3. **Start scope:** default is Phase 0 + Phase 1 first. Confirm or reprioritize.

# LeadRail Memory Architecture

Adapted from a file-plus-graph design note. This records what was **built**, the
corrections the original note needed, and the decisions that are deliberately
still open.

---

## 0. Graphify is not part of this, and never could have been

This needs saying first because the confusion is load-bearing.

| Name | What it actually is | Status here |
|---|---|---|
| **Graphify** (`Graphify-Labs/graphify`) | A **code-graph developer tool**. Turns a source tree into a queryable graph — "what calls this function", "trace this data flow". | Present only as one harvested **prose skill row** in `skills` (`harvested:graphify`). Not installed, not enabled on any account, no dependency. |
| **Graphiti** (`getzep/graphiti`) | A **temporal knowledge graph for agent memory**. Edges carry validity intervals; contradiction invalidates rather than overwrites. | Not adopted — but its *model* is what this implements. |

`MARKETING_OS_SEED_SPEC.md:73` lists *"Graphify — memory graph (BRAIN)"*. That
line assigned a memory-graph role to a codebase-analysis tool on the strength of
its name. `scripts/harvest-skills.ts:164` records the correct read —
`graphify  a code-graph dev tool, not marketing` — in a block headed
`Deliberately EXCLUDED after inspection`, while the same file lists it as an
active source 150 lines later. The exclusion note is stale; the tool shipped
into the catalog anyway.

Nothing was skipped. There was never anything to wire.

---

## 1. Why not adopt Graphiti itself

Graphiti is Python and requires Neo4j or FalkorDB. LeadRail is TypeScript on
Next.js over Supabase Postgres. Adopting it means a second runtime *and* a second
datastore, each with its own auth, tenancy, backup and egress story, to serve an
account whose entire CRM is tens of contacts and whose traversal depth is two to
three hops.

The valuable part of Graphiti is the **temporal model**, and that is about forty
lines of DDL. Postgres already has everything else: `pgvector` is installed and
working, RLS is the established tenancy pattern, and recursive CTEs cover
traversal at this scale.

**Decision: build the model, not the dependency.** Revisit only if traversal
depth or volume makes CTEs the bottleneck — which would be a good problem.

---

## 2. Corrections to the source note

The design was sound. Six things it asserted about LeadRail were not.

| # | The note said | Reality | Consequence |
|---|---|---|---|
| 1 | *"`context.ts` already does entity resolution — reuse it"* | **It does not.** A grep for any message→contact/deal resolution across `lib/` and `app/` returns nothing. `context.ts` resolves the **venture** and otherwise assembles account-level counts. | Entity resolution was a **missing prerequisite**, not a component to reuse. Every retrieval step depended on it. Built as `lib/memory/resolve.ts`. |
| 2 | One markdown file per subject on disk | Serverless Next.js has **no writable disk**. LeadRail's only file storage is Supabase Storage (private buckets for venture decks and outreach attachments) — object storage for binary artifacts, a network round-trip per read. | The projection is a **table** (`memory_subjects`), same one-fetch access pattern, no filesystem. |
| 3 | Add an `agent_episodes` table | `agent_conversations` **already stores every transcript**. A second episode log would duplicate it and drift. | Added one column instead: `agent_conversations.memory_extracted_at` as the extractor's watermark. |
| 4 | *"Read-before-write with a version token, same pattern as your `parse_ok` fix"* | `parse_ok` is **not** optimistic concurrency. It is a deliberately lossy fire-and-forget callback that can undercount. | Real optimistic concurrency was implemented here (`memory_subjects.version`), because losing a projection write leaves the assistant reading stale memory — a different cost from undercounting a metric. |
| 5 | Live turns write nothing but an episode | Already true, but `ingestCarryoverFacts` **only fires on a compaction event**. A short conversation ending normally extracts nothing. | Likely the main reason `agent_memory` has **0 rows in production**. Extraction now runs per-conversation on the tick. |
| 6 | Tier 1 / Tier 2 / never | Correct, and adopted as specified — plus one category the note lacked. | **Declared context**: user-authored facts, authoritative by construction. See §4. |

---

## 3. What was built

```
Live turn (unchanged shape)
  message
    └─> resolveSubjects()            lib/memory/resolve.ts   deterministic, abstains
          └─> loadSubjectMemory()    lib/memory/project.ts   ONE keyed read per subject
                └─> grounding section in context.ts
  ...turn runs, transcript saved to agent_conversations

Async tick (app/api/hermes/tick)
  runMemoryExtraction()              lib/memory/extract.ts   the ONLY writer
    └─> model pass over the transcript tail
    └─> exclusionFor()               lib/memory/tiers.ts     discard before any write
    └─> tierFor()                    lib/memory/tiers.ts     1 = durable, 2 = observed
    └─> writeEdge()                  lib/memory/edges.ts     contradiction -> invalidate
    └─> projectSubjectWithRetry()    lib/memory/project.ts   rebuild the read model
```

**Tables** (migration 061)

- `memory_edges` — source of truth. Bitemporal (`valid_from`, `invalid_at`,
  `invalidated_by`), polymorphic subject, tier, `conversation_id`, `occurrences`.
- `memory_subjects` — generated projection, one row per subject, versioned.

`subject_id` is **TEXT**, not UUID, because `brands.id` is TEXT while
`contacts`/`deals`/`companies`/`ad_campaigns` use UUID. No foreign key: a
polymorphic reference cannot carry one, and a memory row is an audit fact that
must outlive the record it describes.

**Subject types**: `contact`, `company`, `deal`, `campaign`, `segment`,
`channel`, `creative_asset`, `brand`, `account`, `pattern`. `brand` matters most
for a marketing OS — voice rules and prohibitions should condition every
generation call, not just turns that name the brand. `pattern` exists so a Tier 2
observation has a node the promotion gate can point at.

---

## 4. The rules

1. **Live turns never write memory.** They write a transcript and return.
2. **Extraction is the only writer.** One place the tier rules live, one place
   the exclusion list is enforced. The alternative is the failure this codebase
   has already produced twice — four provider clients each reporting usage
   differently, two agent loops each handling a JSON failure differently.
3. **Contradiction invalidates, never overwrites.** `$40k → $65k` keeps both
   rows with their validity windows, so *"what did we believe on 1 August"* is
   answerable. That is what makes an autonomous action auditable months later.
4. **Every fact carries `conversation_id`.** No orphaned assertions.
5. **Tier 2 never self-promotes.** Crossing the occurrence threshold makes a
   pattern *eligible for review*, nothing more. Nothing becomes an operational
   rule without a human.
6. **One canonical subject per fact.** A fact about Jane lives on Jane's node
   even if it surfaced during a deal conversation.
7. **Exclusions are enforced at extraction**, before anything is written. Not at
   projection, not at read. An excluded fact must not exist as an edge that
   merely happens not to be read today.
8. **Declared context outranks inference.** A user-authored fact (`source =
   'declared'`) cannot be superseded by extraction. A person can change what
   they declared; the machine cannot. This is also the **cold-start** answer —
   derived memory is empty until conversations happen, declared context works on
   turn one.
9. **Retrieval is entity-scoped and just-in-time.** Resolve, then one keyed read
   per subject. Never "load everything", never a traversal on the live path.

### Calibration

**Tier 1 — written on first mention.** Role/authority/org, budget, timeline,
contract date, stated need or requirement, objection, decision or commitment;
and for marketing: explicit brand voice rules, compliance constraints, channel
prohibitions, and *measured* campaign outcomes.

**Tier 2 — needs a second occurrence.** Channel and style preferences, tone and
sentiment, passing personal detail, and **inferred performance patterns**. The
bar is enforced hardest here: one A/B result generalised into a permanent rule is
exactly how an automated system does the wrong thing at scale.

**Never written.** The rep's or the system's read on anyone's psychology or
intent; a conclusion drawn from a stated fact but not itself stated; a causal
narrative the system invented (*"underperformed because the audience is
fatigued"*); and the compliance list — financial account numbers, health,
government identifiers, protected attributes, credentials.

Unrecognised facts default to **Tier 2, not Tier 1**. A wrongly-Tier-1 fact gets
acted on; a wrongly-Tier-2 one only gets mentioned.

Every decision — including every skip, with the rule that fired — is logged, so
the thresholds can be tuned against real outcomes rather than guessed.

---

## 5. Deliberately not built yet

**The promotion gate UI.** The queue exists (`listObservedPatterns`,
`promotionCandidates`), and nothing can self-promote. What is missing is the
surface where a human approves a pattern into an operational rule.

Two things already in the codebase are the right mechanism, and neither needs
inventing:

- The `standing_rule` gate class (`lib/capabilities/types.ts`) already marks
  capabilities that *create a rule which later runs without a human in the loop*.
- `approval_grants` exists **in production with zero rows and zero code
  references** — `conversation_id NOT NULL`, `tool`, `uses_remaining`,
  `expires_at NOT NULL`, `revoked_at`, `granted_by`. That is a correctly designed
  session-scoped, per-tool, use-capped, revocable "approve for this session"
  tier, written and never wired.

Approvals today are two-tier: `approved` / `rejected`, single-use. The third tier
is a table waiting for a reader.

**Unifying `agent_memory` with `memory_edges`.** `agent_memory` keeps working
unchanged. Folding it in — so the existing pgvector recall indexes the projection
— is the natural next step, once edges carry real data. Doing it before that
would be refactoring two systems together while neither has content.

---

## 6. The decision that is genuinely open

**Where the Tier 2 → operational threshold sits, and whether the gate is
mandatory.**

`MEMORY_TIER2_THRESHOLD` defaults to 3, which is a guess. The recommendation is
to keep the gate **mandatory** — nothing self-promotes without a human click —
until there are enough promoted-and-verified patterns to trust the threshold
logic itself.

The asymmetry that justifies it: a wrong Tier 1 fact about one contact costs one
relationship. A wrongly-promoted pattern about *what works* steers budget and
creative across every future campaign until somebody notices.

Set it from data, not from this document.

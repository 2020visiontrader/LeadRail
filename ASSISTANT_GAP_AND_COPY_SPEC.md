# Assistant — capability gap (D9) and thinking-step copy spec

Two deliverables. Part 1 is what the assistant cannot do and what it would take.
Part 2 is how its thinking steps should read, which is a copy-and-state problem,
not an architecture one.

---

# PART 1 — The D9 gap, inspected

## The headline: the backends already exist
The missing capabilities are **thin wrappers over functions that are already
written and already tenant-scoped**. This is not new backend work.

| Missing capability | Backing function that ALREADY exists | Where |
|---|---|---|
| `createVenture` | `createVenture(...)` | `lib/db.ts` |
| `updateVenture` (rename, settings) | `updateVenture(...)` | `lib/db.ts` |
| `createSequence` | `createSequence(...)` | `lib/sequences.ts` |
| `updateSequence` | `updateSequence(...)` | `lib/sequences.ts` |
| `setSequenceSteps` | `setSequenceSteps(...)` | `lib/sequences.ts` |
| `createTemplate` | `createTemplate(...)` | `lib/db.ts` |
| `updateTemplate` | `updateTemplate(...)` | `lib/db.ts` |
| `deleteTemplate` | `deleteTemplate(...)` | `lib/db.ts` |
| `listContent` / `createContent` | `/api/content` reads `@/lib/db` directly | `app/api/content/*` (5 routes) |

`app/api/ventures` (4 routes), `/api/sequences` (6), `/api/templates` (3),
`/api/personas` (2), `/api/icp` (2) all exist and work — the UI uses them daily.
Only the **capability declarations** are absent, so the assistant cannot reach
any of it.

## What genuinely needs designing (not just wrapping)
| Item | Why it is not a wrapper |
|---|---|
| **Brand kit** | No table, no API, no concept anywhere in the repo. Needs a schema decision first: is it venture-scoped columns, or its own table with assets/voice/palette? |
| **`deleteVenture`** | Destructive and cascading — a venture owns contacts, campaigns, sequences. Needs a soft-delete + confirmation design, not a DELETE. |
| **Standalone persona create** | `updatePersona` edits sender fields ON a venture. `personas` is a separate table (migration 024) with its own routes. The two concepts are not unified; that is a modelling decision. |
| **Navigation** | "Open the Campaigns tab" has no server-side equivalent — the assistant runs server-side and cannot drive the client router. Needs an SSE event the UI interprets, e.g. `{type:'navigate', href}`. |

## Gate assignment for the new capabilities
Follow the existing six-gate model. Recommended:

| Capability | Gate | Reasoning |
|---|---|---|
| `createVenture`, `createSequence`, `createTemplate`, `createContent` | `internal_write` | Creates LeadRail-side records only; nothing leaves the account, nothing spends. Matches `createCampaign`/`createSegment` precedent. |
| `updateVenture`, `updateSequence`, `updateTemplate` | `internal_write` | Same class as `updatePersona` today. |
| `deleteVenture`, `deleteTemplate` | `destructive` | Matches `deleteDeal`. Must stop and ask. |

Nothing here should be `spend` or `external_send` — none of it contacts a real
person or costs money. Assigning a heavier gate than the action deserves trains
users to click through approvals, which weakens the gates that matter.

## Effort
~10 capability objects following the existing shape (`name`, `domain`, `title`,
`description`, `gate`, `inputSchema`, `zod`, `run`, optional `digest`), plus
registry exports and one `TOOL_VERB` entry each (there is an invariant test that
every capability in `CATALOG_ORDER` has a verb — see `tests/regressions.test.ts`).

Brand kit, `deleteVenture`, persona unification and navigation are separate,
larger pieces and should not be bundled with the wrappers.

---

# PART 2 — Thinking-step copy spec

The goal: the trace should read like someone narrating work in progress, not a
log file. Concretely, four event types with distinct jobs.

## The four types
| Type | Job | Exists in LeadRail |
|---|---|---|
| **Status** | fills the blocking wait; changes over time | ✅ `step_start` (two fixed strings, never escalates) |
| **Thought** | one line of reasoning, before the action | ✅ `narrationFor` (`narration` ?? `thought`) |
| **Action** | the call, named as a verb | ✅ `TOOL_VERB` → `verbFor` |
| **Observation** | what came back, quantified | ⚠️ computed by `observationFor`, never surfaced as copy |

## Rule 1 — Tense flips on completion
A finished step must not read like a running one.

| State | Copy |
|---|---|
| running | `Checking your ventures…` |
| done | `Checked your ventures` |
| failed | `Couldn't check your ventures` |

LeadRail renders the same string in both states with a `✓` swapped in. Half the
"it feels frozen" complaint is this. `StepRow` already knows `done`; it needs a
present/past pair rather than one label.

## Rule 2 — Report the finding, not the lookup
The observation is already computed and thrown away.

| Now | Should be |
|---|---|
| `List leads` | `Found 39 leads across 3 ventures` |
| `Checking your ventures` | `Found 3 ventures — Rentahub, FilmOps, RetentionRail` |
| `Get campaign` | `Campaign is paused, $0 spent` |

`digest()` on each capability already produces exactly this (see
`lib/capabilities/ventures.ts` — it names the ventures). Route `digest` output
into the step label instead of only into the model's transcript.

## Rule 3 — Say why before what
Reason first, action second. LeadRail already does this well and it should be
preserved: *"Pulling your full lead list so I can filter down to just the
FilmOps ones."* → `List leads`.

## Rule 4 — Status copy escalates with elapsed time
One line that changes, not a spinner:

| Elapsed | Copy |
|---|---|
| 0-3s | `Thinking through your request…` |
| 3-8s | `Still working on it…` |
| 8-20s | `This one's taking a moment…` |
| 20s+ | `Almost there…` |

Today there are two fixed strings and no escalation, so a 20-second wait looks
identical to a 2-second one — indistinguishable from a hang.

## Rule 5 — Failure is never dressed as success
The collapsed summary must reflect the LAST step's state:
`Worked through it · 5 steps` when it ended in `✕` is the single most damaging
copy bug in the system. Failed runs should read `Stopped after 5 steps` and
should NOT auto-collapse.
(Already fixed on this branch by removing the collapsing wrapper; keep it that
way if the wrapper ever returns.)

## Rule 6 — Plain verbs, no jargon
`List leads` not `listLeads`. `Checked your ventures` not `Executed
listVentures`. The user never sees a tool name — `TOOL_VERB` exists for exactly
this and already has full coverage.

## What is achievable without architecture change
Rules 1, 2, 4, 5, 6 are copy and component state — no backend change.
**Rule 3 already works.**

## What is NOT achievable today
Token-by-token streaming of the model's reasoning. The route pass is a single
JSON envelope at temperature 0.2 (`maxOutputTokens: 700`); nothing is parseable
until the object closes, so there is no partial thought to stream. Real live
reasoning requires rebuilding the route pass as a streaming call with incremental
parsing — a design change, and it should be decided on its own merits rather than
smuggled in as a copy fix. Rules 1/2/4 close most of the perceived gap without it.

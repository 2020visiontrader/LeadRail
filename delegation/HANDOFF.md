# Handoff — LeadRail copilot remediation

For whoever picks this up next, human or AI. Written 2026-08-17 on
`feat/copilot-remediation`. **The queue table in `README.md` is the source of
truth for status; this file is the source of truth for CONTEXT the specs no
longer carry.**

Read `README.md` (standing rules) and `SPRINT-1-DELTAS.md` first. The plan of
record, `../COPILOT_REMEDIATION_PLAN.md`, is now the OLDEST document here — a
good deal of it describes a tree that no longer exists. Grep before trusting any
file path it names.

---

## 1. Read this before executing anything

**The plan predates most of the work.** Three packets so far were specced
against files that had since moved, and each would have produced a bad diff if
followed literally:

- 1.1 was told to add tools to `TOOLS` in `lib/agent/tools.ts` — 2.1 had made
  that a derived adapter. Adding there forks the declaration 2.1 existed to
  unify and leaves the tools invisible to MCP and the approval gate.
- 5.1 was told to create `lib/skills/normalize.ts` — `scripts/harvest-skills.ts`
  already did most of that job.
- 1.3's verb list and 2.2's capability list were both written when the registry
  was far smaller.

**So: enumerate current state before adding anything.** The registry throws at
import on a `CATALOG_ORDER` gap, which catches a MISSING name but never a
redundant one.

**Verification means running things.** `tsc --noEmit` plus `npm run build`, and
`npm run test:parity` for anything touching capabilities. Several agent reports
this session contained claims that did not survive checking — one asserted a
function had zero callers when it had one. Verify, then trust.

**Infrastructure bug, still live:** agent worktrees are sometimes provisioned on
`e2fc7a2` (a commit on `main`) instead of the branch head. Intermittent — two of
three in one batch. **Always run `git worktree list` and confirm the base commit
before starting.** If it is wrong, `git reset --hard <branch-head>` on the
worktree's own branch. A stale base silently reverts landed packets.

---

## 2. Open packets, with current-state corrections

Status lives in `README.md`. What follows is only what a spec no longer tells you.

### 4 — External MCP client bridge (Tier A)
Unstarted. Note 0.3 rebuilt MCP auth: `mcp_api_keys` with per-key
`allow_sensitive`, sha256-hashed tokens, a 60/min rate limit, and an audit row
per sensitive call. Build the bridge on that, not on `APP_API_SECRET` — the
legacy path is deliberately capped at read + safe-write.

### 5.2 — DONE (commit `66f806e`, 24 templates)
NOTE: `scripts/harvest-personas.ts` was NOT saved before its executor died, so
re-harvesting needs that script rewritten first. Original note: digital-marketing-pro ships 24 specialist agent definitions
(Marketing Strategist, Brand Guardian, SEO Specialist, CRM Manager …) that map
onto `personas`. Same licence discipline as 5.1: MIT/Apache paths only.

### 6.2 — Coordinator fan-out (Tier A) — **PARTIAL, finish this**

Commit `66f806e` landed the scaffolding, NOT the fan-out. `getCoordinator()` is
now read, and when a turn @mentions personas the coordinator FRAMES one unified
reply. But there is no delegated execution — the loop still runs a single pass.
The code marks it itself: `TODO(coordinator synthesis)` at `lib/agent/loop.ts`
line ~371.

Ready for whoever finishes it: a per-call `maxSteps` override clamped to
`[1, MAX_STEPS]` (it can only SHRINK a delegate's budget, never grow it),
`MAX_FANOUT_DELEGATES = 3`, and a `MAX_FANOUT_TOTAL_STEPS` ceiling.

Missing: actually running each mentioned persona and synthesising from what they
RETURNED. Synthesis must never invent a result a delegate did not produce — the
OBSERVATION discipline and packet 10.1's digests apply. Every delegate stays on
the same `accountId`, every sensitive tool still passes the 0.1 approval gate and
the 1.4 budget gate, and a failed delegate is reported, not silently dropped.

### (was) 6.2 — original note
`personas.is_coordinator` exists, with logic ensuring one per account, and
**nothing reads it.** This is the packet that turns one assistant into a
coordinated set. Highest-value remaining item for the product vision.
Touches `lib/agent/loop.ts` — coordinate with anything else editing it.

### 7.1 — OAuth for LinkedIn / TikTok / X (Tier A, one packet each)
`lib/social/providers.ts` already lists them with `live: false`. Because 2.2-S
made platform handling registry-driven, flipping a provider to `live: true`
makes it a valid argument with **zero edits** to `lib/capabilities/social.ts` —
you only add one entry to the `PUBLISHERS` map. Verified by experiment, not
assumption.

Also: packet `a2db6f4` added `force_reauth=true` to the Instagram authorize URL
so a second account can be added. **Untested against live Meta.** If LinkedIn or
X behave the same way, they will need the equivalent.

### 7.3 — Automation runner (Tier A) — **genuinely last**
The only packet where the platform messages real people with no human in the
loop. `social_automations` rows exist (migration 040) and are created disabled;
enabling is a separate approval. `daily_cap` has a DB CHECK (≤200). The runner
must enforce the cap **at send time** — increment `sends_today`, reset on date
change, stop at the cap. Until it exists, rules never fire, which is the safe
failure mode.

---

## 3. Found this session, specced or noted, NOT built

Ordered by what I would do first.

1. **Sensitive-baseline test.** 2.3's parity suite proves the API and MCP
   surfaces agree — but flipping a capability's `gate` does NOT fail it, and
   structurally cannot: every surface derives sensitivity from the gate, so
   moving it moves all four consistently. Reclassifying `sendEmail` to `read`
   would remove the approval card, the audit row and the MCP `allow_sensitive`
   requirement in one line with nothing objecting. Needs a frozen list of
   sensitive names so a downgrade is an explicit, reviewable edit.

2. **Inbox capabilities.** The assistant cannot read the inbox. `inbox_messages`
   is populated, tenant-scoped, threaded on `thread_id`, and reply-send exists —
   but there is no capability, so Thragg cannot answer "did anyone reply?".
   Wants `listInboxMessages` (read), `getInboxThread` (read),
   `replyToInboxMessage` (**`external_send`**, must go through
   `sendInboxReply` so suppression and threading apply).

3. **`getInbox` is flat and unbounded.** Returns 50 loose rows via `select('*')`,
   never grouped by `thread_id` despite it being stored. No filtering, no
   pagination — message 51 is invisible to everything.

4. **Skills enable-cap.** 353 skills are catalogued; `account_skills` gates what
   reaches a prompt, and 0 are enabled, so the budget is safe today. There is no
   CAP on how many one account may enable. 10.3 solved the equivalent for tools
   (staged, behind a flag). Not urgent; should not be discovered the hard way.

5. **Two ungated credit-spending routes.** `app/api/leads/apollo/search` and
   `app/api/leads/[id]/enrich` call Apollo directly, bypassing the capability
   layer and therefore 1.4's budget gate. They are ungated because
   `searchPeople`/`matchPerson` take no `accountId` — `sourceLeads` even
   discards it (`run: (_accountId, a) => …`). Fixing needs a signature change.

6. **The budget meter is dormant.** 1.4 wired `checkBudget` into `runTool`, but
   `credit_transactions` is never debited: `applyCredits`' only caller is
   `lib/referrals.ts`, which CREDITS. So `spent` is always 0 and the hard stop
   cannot fire. Correct while the app is free and internal; blocking before
   billing.

7. **Usage logging misses the live ladder.** `logUsage` only runs inside
   `tryRegistry`, and no account has a provider registry, so `ai_usage` has 0
   rows. The Zo → OpenCode → NIM path records nothing.

8. **Hugging Face content provider.** Zero references in the repo. Net-new, as
   are Higgsfield and Seedance. Build ONE provider interface for all three
   rather than three bespoke integrations — `lib/ai/providers.ts` is the right
   shape to extend.

9. **`EmailPreview` residual.** 9.2 sanitised it, but `style="width:expression(…)"`
   survives. IE-only and dead in supported browsers; noted so a reviewer does
   not assume CSS is parsed.

10. **`TOOL_VERB` invariant is a comment, not a check.** 60/60 today. A
    capability landing without a verb degrades silently to its title. Making it
    structural needs a unit test — vitest config now exists (2.3), so this is
    cheap.

---

## 4. Operational — only the operator can do these

1. **Deploy.** The database is AHEAD of the deployed code (migrations 037–041
   applied). That is the safe direction, but the credential-leak fix in
   `/api/integrations` and everything since is not live until a deploy runs.
2. **`ZO_Api_Key`** must be set in the hosting env. Its absence is why the
   assistant reported "temporarily unavailable" — `agentConfigured()` needs one
   AI key and the old `.env.local.example` did not list any. **Note the mixed
   case.**
3. **`NVIDIA_API_KEY`** is the EMBEDDING provider, not just a fallback LLM.
   Without it `agent_memory` rows get NULL embeddings and semantic recall
   degrades to recent-facts-only.
4. **Rotate the Zo token** that was pasted into a chat transcript.
5. **Counsel review** on `/privacy` and `/terms`. Both carry a visible draft
   banner. Excalix (Toronto, Ontario) is named; PIPEDA framing, Ontario
   governing law, EU data storage (Supabase eu-north-1) stated as fact. CASL
   applies and the product does NOT implement consent capture — both documents
   say so plainly, and must keep saying so until it does.
6. **Test the Instagram account chooser** after deploy.
7. **`main` has diverged.** It carries commits this branch does not
   (`e2fc7a2`, `61dc49a`). Reconcile before merging.

---

## 5. What is actually solid

Worth knowing what NOT to re-litigate:

- **The approval gate.** Server-side, audited, extended to MCP callers, verified
  `pending → executed` against the real database. Anything reaching a real
  person or spending money declares a gate and inherits it automatically.
- **Tenant scoping.** Every capability passes a server-derived `accountId`;
  queries filter in-query. `loadTranscript` returns `[]` for foreign ids exactly
  as for unknown ones — no existence oracle.
- **The registry as single source of truth.** One declaration feeds the chat
  loop, MCP, the approval gate and the audit trail, and 2.3 now asserts the
  surfaces cannot drift apart.
- **Multi-account social.** One row per Page and per linked IG account, no
  overwrite, with ambiguity throwing rather than guessing.

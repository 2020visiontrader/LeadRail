# Delegation queue — LeadRail copilot remediation

Plan of record: `../COPILOT_REMEDIATION_PLAN.md`. Packets live in this folder.

## How to run a packet

The executor needs real file + shell access (it must run `npx tsc --noEmit && npm run build` itself). Claude Code in this repo is the intended surface:

```bash
cd ~/Desktop/LeadRail
git checkout -b feat/copilot-remediation   # once
claude
```
then:
```
Read delegation/PACKET-<id>.md and implement it exactly.
Obey the executor preamble at the top. Stop and ask if anything is ambiguous.
```

One packet per session. One commit per packet, message = packet id + title.

**A packet is NOT done until:**
1. `npx tsc --noEmit` passes
2. `npm run build` passes
3. the diff has been reviewed against that packet's acceptance criteria by a human/architect — not self-certified by the executor

Never start packet N+1 with N unreviewed. The whole point of small packets is that a bad diff is caught while it is still small.

## Model tier per packet

Route by *failure cost*, not size. Anything touching `account_id`, approval state, or outbound sends is Tier A.

| Packet | Title | Tier | Status |
|---|---|---|---|
| 0.1 | Gate execution on approval state | A | ☑ merged |
| 0.2 | Stop trusting the client transcript | A | ☑ merged |
| 0.2b | CommandBar → 0.1 + 0.2 contracts | B | ☑ merged |
| 0.3 | Close the MCP server bypass | A | ☑ merged |
| 1.1 | Memory ingestion path (`rememberFact`) | B | ☑ merged |
| 1.2 | Conversation persistence + compaction | B | ☑ merged |
| 1.3 | Small correctness fixes | C | ☑ merged |
| 1.4 | Enforce the spend budget (zero callers) | A | ☑ merged (gate live, meter dormant) |
| 2.1 | Capability Registry core | A | ☑ merged |
| 2.2 | Domain backfill (15 domains, parallel) | B | ☐ |
| 2.2-S | Social capabilities | A | ☑ merged |
| 2.3 | API=MCP parity test | B | ☐ |
| 3.1 | Ground the background agents | A | ☐ |
| 4 | External MCP client bridge | A | ☐ |
| 5.1 | Re-clone + finish skills harvest | C | ☐ spec ready (unblocked 2026-08-16) |
| 5.2 | Agent roles → persona templates | C | ☐ |
| 6.1 | Persona picker UI | C | ☐ |
| 6.2 | Coordinator fan-out | A | ☐ |
| 7.1b | Fix misleading Connections UI | C | ☑ merged |
| 7.1 | OAuth: LinkedIn / TikTok / X (×3) | A | ☐ |
| 7.2 | Per-account Buffer/GHL credentials | A | ☐ |
| 7.3 | Automation runner | A | ☐ do LAST |
| 8.1 | Split the loop: route ≠ compose | A | ☑ merged |
| 8.1b | Output budget follows the model | B | ☑ merged |
| 8.2 | Stream the compose pass | B | ☑ merged |
| 9.1 | Render the assistant's markdown | B | ☑ merged |
| 9.2 | Sanitize the email template preview | A | ☑ merged |
| 10.1 | Observation digests (result → language) | B | ☑ merged |
| 10.2 | Prompt prefix order + plan/narration split | B | ☐ spec ready |
| 10.3 | Two-stage tool catalog | B | ☑ merged (opt-in flag) |
| 11.1 | Legal entity + AI subprocessor disclosure | A | ☑ merged · DRAFT, needs counsel |
| 11.2 | Public landing page | C | ☑ merged |

## Order to actually run

**Sprint 1 — security + dead features.** `0.1 → 0.2 → 0.3 → 1.1 → 1.2 → 1.3`
Closes the whole security surface and switches on every built-but-disconnected feature. Touches no tool definitions, so it cannot conflict with Phase 2.

**Sprint 2 — the registry.** `2.1 → 2.2 (parallel by domain) → 2.2-S → 2.3`
2.1 is a pure port with zero behaviour change; it reviews fast. Nothing else in Phase 2 can start until it lands.

**Anytime, independent:** `7.1b` (five-line UI fix), `5.1`, `7.1`, `7.2`, `3.1`.

**Last:** `7.3` — the only packet where the platform messages real people with no human in the loop.

## Standing rules for every executor

- Touch only the packet's file list. If something else must change, stop and report.
- Never rename an exported symbol or change a signature unless the packet says to.
- Never "improve" a description, schema, or bug you noticed in passing — report it, don't fix it. Behaviour changes must be reviewable as changes, not buried in a refactor.
- Silent-catch (`catch {}`) is for best-effort writes only — memory, logging, persistence. **Never for a gate.**
- Every DB query filters by `account_id` *in the query*, not after fetching.

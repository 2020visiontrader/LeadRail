# PACKET 0.1 — Gate execution on approval state

**Tier:** A (security) · **Branch:** `feat/copilot-remediation` · **Blocks:** nothing, but is the highest-priority defect in the repo.

---

## Executor preamble (obey exactly)

You are an executor. Implement EXACTLY this packet against `/Users/franckiemacair/Desktop/LeadRail`.

1. Touch ONLY the files under **Files**. If another file must change, STOP and report why.
2. Do not rename exported symbols or change existing signatures unless told to.
3. Preserve the repo's comment style: explain WHY; mark additive changes as additive.
4. Do not "improve" anything you notice in passing — report it instead.
5. If any instruction is ambiguous, STOP and ask ONE question. Do not guess.

---

## The defect

`lib/agent/loop.ts` resumes execution from `input.approve = { tool, args }`. It checks only `TOOLS[tool]?.sensitive`, calls `markApprovedByToolAndArgs` best-effort, then runs the tool.

**It never reads the approval row's state.** Meanwhile `POST /api/approvals/:id` with `decision:'rejected'` only updates a row — it blocks nothing.

Consequence: **a rejected proposal executes if the same `{tool, args}` is resubmitted.** The self-approval guard, edit-invalidation, and audit trail in `lib/approvals/store.ts` all sit on a path with no authority over execution. This affects `launchCampaign` (spends ad budget), `sendEmail` and `enrollInSequence` (message real people), `sourceLeads` and `enrichLead` (burn credits).

## The contract

Executing a sensitive tool requires a persisted approval row that is:
- `state = 'approved'`, and
- belongs to this `account_id`, and
- matches `hashArgs(args)` and the tool name, and
- has not already been consumed.

Consumption is **atomic and single-use** — no replay.

---

## Files

**Create:** `migrations/037_approval_execution.sql`
**Modify:** `lib/approvals/store.ts`

Do NOT modify `lib/agent/loop.ts` or the agent routes in this packet — those edits are applied separately after review.

---

## Step 1 — `migrations/037_approval_execution.sql`

Idempotent, safe to re-run, matching the style and comment density of `028_approvals.sql` (read it first).

Required statements:
- Drop and re-add the state CHECK constraint to add `'executed'`:
  `state IN ('pending','approved','rejected','expired','invalidated','executed')`
  (use `ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_state_check;` then add it back)
- `ALTER TABLE approvals ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;`
- `CREATE INDEX IF NOT EXISTS idx_approvals_account_tool_hash ON approvals(account_id, tool, args_hash);`

Header comment must explain: migration 028 created the approvals table as an audit trail alongside an ephemeral transcript-resume flow that never consulted it; this migration adds the terminal `executed` state that makes the row authoritative for execution, so an approval is single-use and a rejected one can never run.

## Step 2 — `lib/approvals/store.ts`

Add to the `ApprovalState` union: `'executed'`.

Add a new error class and one exported function:

```ts
export class ApprovalExecutionError extends Error {
  constructor(
    public code: 'not_found' | 'not_approved' | 'args_mismatch' | 'already_executed',
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalExecutionError';
  }
}

/**
 * Atomically consume an approved approval so a sensitive tool may run ONCE.
 * ...
 */
export async function consumeApprovalForExecution(
  accountId: string,
  approvalId: string,
  tool: string,
  args: Record<string, any>,
): Promise<void>
```

Implementation requirements — follow exactly:

1. Fetch the row scoped by BOTH `id` and `account_id`. Not found → throw `not_found`.
2. `row.tool !== tool` OR `row.args_hash !== hashArgs(args)` → throw `args_mismatch`.
   (Reuse the existing exported `hashArgs`. Do not write a new hash.)
3. `row.state === 'executed'` → throw `already_executed`.
4. `row.state !== 'approved'` → throw `not_approved`.
5. Consume atomically — the UPDATE itself must be the guard, NOT a read-then-write:
   ```
   UPDATE approvals
      SET state='executed', executed_at=now(), updated_at=now()
    WHERE id=$1 AND account_id=$2 AND state='approved'
   RETURNING id
   ```
   Zero rows returned → throw `already_executed` (a concurrent caller won the race).

Follow the existing file's supabase query style (`.eq(...).select().single()` / `.maybeSingle()`), and mirror how `decideApproval` does its state-conditioned update with the `.eq('state','pending')` belt-and-suspenders guard.

**Critical:** this function must NEVER swallow an error. The existing file uses silent-catch for best-effort writes (`markApprovedByToolAndArgs`); this is the opposite — it is a gate, and any failure must propagate so the caller refuses to execute.

Add a short comment above the function explaining that unlike `markApprovedByToolAndArgs` (best-effort, fire-and-forget), this is the authoritative execution gate and its failure MUST block the tool call.

---

## Acceptance criteria

1. `./node_modules/.bin/tsc --noEmit` passes.
2. `consumeApprovalForExecution` is exported and throws `ApprovalExecutionError` with each of the four codes on the right condition.
3. The consuming UPDATE is state-conditioned in the query (`state='approved'` in the WHERE), not decided in JS after a read.
4. Every query filters by `account_id` **in the query**.
5. No `catch {}` anywhere in the new function.
6. `hashArgs` is reused, not reimplemented.
7. Migration is idempotent — running it twice is safe.
8. `lib/agent/loop.ts` was NOT modified.

## Reviewer checklist (human — do not self-certify)

- [ ] The UPDATE cannot double-execute under concurrency (state in WHERE, zero-rows → throw).
- [ ] `not_approved` fires for `rejected`, `pending`, `invalidated`, and `expired` alike.
- [ ] `args_mismatch` fires when args changed after approval (edit-invalidation actually bites).
- [ ] Nothing silently degrades to "allow".

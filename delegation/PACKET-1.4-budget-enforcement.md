# PACKET 1.4 — Enforce the spend budget that already exists

**Tier:** A (money) · **Branch:** `feat/copilot-remediation` · **Depends on:** nothing.

Found 2026-08-17 by scanning for built-but-disconnected exports — the same class
of defect as packet 1.1 (`recordFact` had zero callers), but the stakes are money
rather than memory.

---

## The problem

`lib/budgets/store.ts` implements a monthly spend budget with a hard stop:

```ts
export async function checkBudget(accountId: string): Promise<{ allowed: boolean; reason?: string }> {
  const status = await getBudgetStatus(accountId);
  if (status.enabled && status.overLimit) {
    const budget = await getBudget(accountId);
    if (budget?.hard_stop) return { allowed: false, reason: 'Monthly spend limit reached' };
  }
  return { allowed: true };
}
```

**`checkBudget` has zero callers.** Verified across `lib/`, `app/` and `src/`.
`account_budgets` is referenced only by its own store and the CRUD route at
`app/api/budgets/route.ts`.

So an operator can set a monthly limit, tick "hard stop", see it saved, and the
platform will keep spending straight through it. The UI implies a control that
does not exist. That is worse than having no budget feature, because it
manufactures false confidence about the one thing that costs real money.

## What must call it

Every path that commits real spend. Find them from the capability registry
rather than guessing — the `spend` gate is the definition:

```
grep -n "gate: 'spend'" lib/capabilities/*.ts
```

At minimum `launchCampaign` and anything that consumes credits
(`lib/credits.ts`, `recordAiUsage`). Also consider `setAdStatus` with
`ACTIVE` (packet 2.2-S) — resuming a paused campaign restarts spend and is
already gated `external_send` for that reason.

## Design constraints

- **This is a GATE.** No silent catch. If the budget lookup fails, decide
  explicitly and document the choice in a comment. Fail-closed is the safer
  default for money; if you fail open, you must justify it in the report.
- **Refuse before the spend, not after.** The check belongs before the external
  call, not after the money has left.
- The refusal must reach the user as a clear message, not a generic error. The
  agent loop already has a pattern for this — see `approvalRefusal()` in
  `lib/agent/loop.ts`.
- `hard_stop: false` means warn, not block. Preserve that distinction — a soft
  budget that silently blocks would be its own bug.
- Account-scoped in-query, as always.

## Files

**Modify:** the capability files carrying `gate: 'spend'`, and/or `lib/credits.ts`
— whichever is the true chokepoint. Prefer ONE chokepoint over sprinkling the
call at many sites; a gate with several entrances is a gate someone will forget.

If the right chokepoint turns out to be somewhere else, STOP and report before
editing widely.

## Acceptance criteria

1. `./node_modules/.bin/tsc --noEmit` and `npm run build` pass.
2. `checkBudget` has at least one real caller on every `spend`-gated path.
3. With `hard_stop: true` and the limit exceeded, the spend is refused and the
   user sees why.
4. With `hard_stop: false`, the spend proceeds (warning only).
5. With no budget configured, behaviour is unchanged from today.
6. No silent catch on the gate.

## Reviewer checklist (human — do not self-certify)

- [ ] Every `gate: 'spend'` capability is covered — enumerate them and check each.
- [ ] The check runs BEFORE the external call.
- [ ] A DB failure during the check cannot silently permit spend.
- [ ] Soft vs hard budget behaviour is distinct and correct.
- [ ] The refusal message is human-readable and names the reason.

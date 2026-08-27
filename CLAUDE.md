# LeadRail — working agreements

## Model roles (standing rule)

**Opus and Fable plan and review. They do not implement.**
**Sonnet and Haiku execute.**

When running as Opus or Fable on this repo:

- Investigate, diagnose, design, scope, and review — then hand the
  implementation to Sonnet or Haiku via the Agent tool.
- Review what comes back before it ships. Delegation moves the typing, not the
  responsibility: the plan's author owns the result, including tests actually
  passing and the revert-check below actually being run.
- Trivial in-flight mechanics (a commit of work already written, a status
  query) do not need delegating. A change to source does.

Write the plan so it can be executed without the planning context: name the
files, the exact behaviour wanted, and what proves it correct.

## How work is verified here

These are not style preferences. Each one was learned from a defect that
shipped or nearly shipped in this codebase.

**Revert-check every new test.** Disable the fix, confirm the test actually
fails, restore it. A test that passes without its fix is worse than no test,
because it reports safety that is not there. This has caught two real cases:
a deadline test that went green against a deleted deadline (an unrelated
duplicate-suppression guard happened to stop the loop at the same step), and a
helper whose default parameter silently tested the wrong branch.

**Predicted failures must match observed failures.** If you expect two tests to
go red and one does, stop and find out why. That gap is the finding.

**Verify against reality, not against the return value.** Migrations are
checked with `information_schema`, not `success: true`. Production claims are
checked by querying production. "It should work" is not a result.

**Watch for the house anti-pattern: written but never read.** Eleven instances
found so far — a column maintained on every save and used as a condition
nowhere, an endpoint that was correct and called by nothing, a scheduler
configured in a markdown file instead of a config file. Before adding a
column, a flag, or an endpoint, name what reads it. Before believing a feature
works, find its caller.

**Two agent loops exist** (`runAgentImpl` and `runAgentStreamImpl` in
`lib/agent/loop.ts`) and must stay identical. The streaming one is what real
chat turns run. A fix applied to only one is not applied.

**Extract for testability when the defect is in the path, not the parts.**
`lib/agent/json-envelope.ts` and `lib/agent/stream-outcome.ts` exist because
every function involved was individually correct and the control flow between
them was not. A test that re-implements the path cannot see that class of bug.

## Before shipping

`npx tsc --noEmit` · `npx vitest run` · `npx next build` — all three, all clean.
Then commit. Do not report done without them.

## Dated risks

`BACKLOG.md` holds known risks with real dates and what proves each one closed.
Read it before assuming something is unfinished — and add to it rather than
leaving a date-sensitive risk in a conversation.

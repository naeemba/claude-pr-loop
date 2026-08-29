---
description: Run the full PR review -> fix -> re-review chain with fresh-context subagents (up to 6 rounds). Subagents push commits autonomously.
argument-hint: <pr-number>
---

Run the PR review/fix/re-review loop for PR #$ARGUMENTS.

Call the `Workflow` tool with:
- `scriptPath`: the ABSOLUTE path to `pr-loop.js` — your home directory followed by
  `/.claude/workflows/pr-loop.js`. The Workflow tool does not expand `~`.
- `args`: `"$ARGUMENTS"` — or `{ "pr": "<pr#>", "stopAt": ..., "maxRounds": ... }`
  when the invocation asks for a different severity floor or round cap

This is explicit user opt-in for multi-agent orchestration — they invoked this slash command.

The workflow runs one fresh-context subagent per role per round (review in round 1, re-review after, then fix), looping until a review round leaves zero unresolved threads on the PR, only threads at or below the severity floor remain (handed back for a manual pass), a fix round makes zero progress, or 6 rounds elapse.

## Review dimensions

The review and re-review rounds execute the `/pr-review` and
`/pr-rereview` command bodies verbatim — correctness first, then existing
patterns, structure and layering, frontend layout, naming, test value, and
reuse, deduplicated to one comment per root cause. The dimensions live in those
command bodies; do not restate them here.

## Severity

Every posted finding opens with a bold severity tag —
`blocker` / `high` / `medium` / `low` / `nit`. The full scale, the rules against
inflation, and the re-review specifics live in the `/pr-review` and
`/pr-rereview` command bodies, which every round's subagent reads and executes
verbatim. Do not restate or reinterpret the scale here.

Two things are specific to the loop:

- **The loop stops once only a `low`/`nit` tail is left.** Those are handed back
  for a manual pass rather than costing another re-review + fix agent pair. The
  floor is `stopAt` (default `low`); pass `stopAt: 'nit'` to only stop on a fully
  clean PR. A `blocker` still never stops the loop early — the floor is a bottom,
  not a priority order.
- **An untagged thread always counts as above the floor.** A human reviewer's
  plain comment carries no tag, and it must never be the thing that ends the loop.
  Every round classifies ALL unresolved threads, not just the ones it posted.

Because the floor makes severity load-bearing, a mislabelled finding now has a
cost: tag `low` something that is really `medium` and the loop hands it back
instead of fixing it. That is the trade being made deliberately — it buys a round
per run.

> NOTE: the per-round subagent prompts live in `~/.claude/workflows/pr-loop.js`
> and execute the `/pr-review`, `/pr-rereview` and `/pr-address` command
> bodies verbatim. Keep the script and these command files in sync when either
> changes.

When the workflow returns, summarize:
- Final status (`converged` / `stopped-at-floor` / `no-progress` / `max-rounds-hit`)
- Number of rounds run
- Total commits pushed across all fix rounds
- Anything notable from the round history

On `stopped-at-floor`, the point of the run is the hand-back: list every thread in
`handBack` verbatim — path, line, tag, what it asks for — so the remaining pass
can be done without reopening the PR. Say plainly that these were left unfixed by
choice, not missed.

`no-progress` now has a second meaning worth spelling out: the only threads left
are ones a fix round already rejected and deliberately did not re-argue. Those are
usually a human's comments, which `/pr-address` replies to but never resolves.
Name them — the run ended because it had nothing left to say, not because the PR
is clean.

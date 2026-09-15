---
description: Run the full PR review -> fix -> re-review chain with fresh-context subagents (up to 6 rounds). Subagents push commits autonomously.
argument-hint: <pr-number>
---

Run the PR review/fix/re-review loop for PR #$ARGUMENTS.

Call the `Workflow` tool with:
- `scriptPath`: the ABSOLUTE path to `pr-loop.js` — your home directory followed
  by `/.claude/workflows/pr-loop.js`. The Workflow tool does not expand `~`.
- `args`: `"$ARGUMENTS"` — or an object when the invocation asks for more than
  the defaults:
  - `stopAt` — the severity floor the loop stops at, default `low` (see below)
  - `maxRounds` — the round cap, default 6
  - `startAt: "rereview"` — begin round 1 with `/pr-rereview` instead of
    `/pr-review`. For a PR whose findings were already fixed in another session
    or by hand: without it, round 1 reviews the fixed head from scratch, posts
    findings that are already dead, and round 1's fix agent burns itself
    replying to the duplicates it just made.
  - `worktree: true` — run every round's agent in its own git worktree, so the
    loop never touches the branch checked out in the working copy. Use it when
    you want to keep working while the loop runs.

This is explicit user opt-in for multi-agent orchestration — they invoked this slash command.

The workflow runs one fresh-context subagent per role per round (review in round 1, re-review after, then fix), looping until a review round leaves zero unresolved threads on the PR, only threads at or below the severity floor remain (one last fix pass, then stop), a fix round makes zero progress, or 6 rounds elapse.

## Review dimensions

The review and re-review rounds execute the `/pr-review` and
`/pr-rereview` command bodies verbatim — correctness first, then existing
patterns, structure and layering, frontend layout, naming, test value, and
reuse, deduplicated to one comment per root cause. The dimensions live in
`~/.claude/review/standard.md`, which those command bodies read; do not restate
them here.

## Severity

Every posted finding opens with a bold severity tag —
`blocker` / `high` / `medium` / `low` / `nit`. The full scale and the rules
against inflation live in `~/.claude/review/standard.md`; the re-review
specifics live in the `/pr-rereview` command body. Every round's subagent reads
and executes both verbatim. Do not restate or reinterpret the scale here.

Three things are specific to the loop:

- **The loop stops once only a `low`/`nit` tail is left — after fixing it.** That
  round's fix agent still runs and addresses the tail; what does not run is
  another re-review to check it. Verifying a nit costs a review + fix agent pair,
  which is more than the nit is worth. The floor is `stopAt` (default `low`);
  pass `stopAt: 'nit'` to only stop on a fully clean PR. A `blocker` still never
  stops the loop early — the floor is a bottom, not a priority order.

  Raising `stopAt` above `low` raises what that last unverified round handles.
  `stopAt: 'medium'` means a `medium` finding — a route that checks a session
  exists but never checks it owns the row — gets fixed in a small diff with no
  re-review behind it. The default is `low` for that reason.

  The trade: the last commits of a run are pushed without a review round behind
  them. The final fix agent is told it is last and told to reject anything it
  cannot fix safely in a small diff, but if a `low` fix breaks a test, no round
  after it will catch that. Read the final diff.
- **An untagged thread always counts as above the floor.** A human reviewer's
  plain comment carries no tag, and it must never be the thing that ends the loop.
  Every round classifies ALL unresolved threads, not just the ones it posted.
- **A thread waiting on a person does not count at all.** Someone else raised it,
  and the last comment on it is a reply from our side, so the ball is in their
  court. Left in the count, it spawns a fix agent with nothing to do every
  remaining round. The review round reports these in `blockedOnHuman` and the loop
  subtracts them. A thread whose last comment is theirs is NOT blocked: it is a
  finding, and the fix round owns it.

Because the floor makes severity load-bearing, a mislabelled finding now has a
cost: tag `low` something that is really `medium` and the loop fixes it in the
final round, in a small diff with nothing after it to check. That is the trade
being made deliberately — it buys a round per run.

> NOTE: the per-round subagent prompts live in `~/.claude/workflows/pr-loop.js`
> and execute the `/pr-review`, `/pr-rereview` and `/pr-address` command
> bodies verbatim. Keep the script and these command files in sync when either
> changes.

When the workflow returns, summarize:
- Final status (`converged` / `floor-addressed` / `stopped-at-floor` / `no-progress` / `max-rounds-hit`)
- Number of rounds run
- Total commits pushed across all fix rounds
- Anything notable from the round history

`floor-addressed` is the normal quiet ending: only a tail at or below `stopAt`
was left — name the actual floor from the result, since it may be higher than
the `low` default — the final fix pass took it, and no re-review followed. List
every thread in
`floorThreads` — path, line, tag, what it asks for — and mark the ones named in
`rejectedThreads` as rejected, with the reason given there. Those are still open.
Give `addressed`/`rejected` too: if both are zero, the final round did nothing
and every thread on the list is untouched — say that outright. Say plainly that
nothing verified those last commits, and that the diff is worth a glance.

`stopped-at-floor` now means only the narrow case: nothing above the floor and
nothing a fix round could touch either — every remaining thread is waiting on a
person. Nothing was left unfixed by choice; there was nothing to fix.

List `blockedOnHuman` separately and under its own heading, whatever the status.
Those are not a to-do list — they are questions someone is waiting on an answer
to, and the loop stopped because it had already said everything it could.

`no-progress` now has a second meaning worth spelling out: the only threads left
are ones a fix round already rejected and deliberately did not re-argue. Those are
usually a human's comments, which `/pr-address` replies to but never resolves.
Name them — the run ended because it had nothing left to say, not because the PR
is clean.

---
description: Run the full PR review -> fix -> re-review chain with fresh-context subagents (up to 6 rounds). Subagents push commits autonomously.
argument-hint: <pr-number>
---

Run the PR review/fix/re-review loop for PR #$ARGUMENTS.

Before anything else, check the installed workflow copy is current. It is a
copy, not a link, so a `git pull` in the checkout leaves it running old code
next to new command files:

    checkout=$(dirname "$(dirname "$(readlink ~/.claude/commands/pr-loop.md)")") && cmp -s "$checkout/workflows/pr-loop.js" ~/.claude/workflows/pr-loop.js

If it fails, stop and tell the user to re-run `./install.sh` in the checkout.

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
  - `reviewModel` / `fixModel` / `conflictsModel` — the model (and, with it, the
    effort) each kind of round runs at. `reviewModel` defaults to `opus` at
    high effort and stays pinned so a cheaper parent session cannot quietly
    downgrade the only rounds deciding what is wrong with the code.
    `fixModel` and `conflictsModel` default to `inherit` — same model and
    effort as the session that typed `/pr-loop`. Pass an explicit tier (`sonnet`, `opus`, …) to pin those rounds,
    at low effort;
    pass `null`, `"session"` or `"inherit"` for `reviewModel` to put review on
    the session too. This command file itself has no `model`/`effort`
    frontmatter and always runs on the session that typed `/pr-loop`.

This is explicit user opt-in for multi-agent orchestration — they invoked this slash command.

The workflow runs one fresh-context subagent per role per round (review in round 1, re-review after, then fix), looping until a review round leaves zero unresolved threads on the PR, only threads at or below the severity floor remain (one last fix pass, then stop), a fix round makes zero progress, or 6 rounds elapse. It also ends before any round starts when the conflict step leaves a conflict open (see Conflicts below).

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

## Conflicts

Before the first review, one agent asks the forge whether the PR conflicts with
its base branch. If it does, the agent merges the base branch in and resolves the
conflicts by hand. The rounds then review and fix the merged code, so the merge
commit never lands on the branch with no review behind it.

The rules for that merge live in `pr-conflicts.md` — merge never rebase, keep
both sides, abort rather than guess. Do not restate them here.

If the agent aborts and leaves a conflict open, the run stops there with status
`conflicts-unresolved` and no rounds. A person has to pick a side first, and
reviewing code that is about to change wastes every round.

The base branch keeps moving while the rounds run. A long run can still end on a
PR that conflicts again. The loop does not check a second time.

> NOTE: the per-round subagent prompts live in `~/.claude/workflows/pr-loop.js`
> and execute the `/pr-review`, `/pr-rereview`, `/pr-address` and `/pr-conflicts`
> command bodies verbatim. Keep the script and these command files in sync when
> either changes.

Summarize from the returned result alone: `history` holds counts per agent,
`commitShas` every commit. Do not open the task output files.

When the workflow returns, summarize:
- Final status (`conflicts-unresolved` / `converged` / `floor-addressed` / `stopped-at-floor` / `no-progress` / `max-rounds-hit` / `agent-error`)
- Number of rounds run
- The commits pushed, from `commitShas`. On `agent-error`, lead with these:
  they are on the branch, and the round meant to review them never ran.
- Anything notable from the round history

`floor-addressed` is the normal quiet ending: only a tail at or below `stopAt`
was left — name the actual floor from the result, since it may be higher than
the `low` default — the final fix pass took it, and no re-review followed. List
every thread in `floorThreads` — path, line, tag, what it asks for — and mark
the ones named in the last `history` entry's `rejectedThreads` as rejected,
with the reason given there. Those are still open. Give that entry's
`addressed`/`rejected` too: if both are zero, the final round did nothing and
every thread on the list is untouched — say that outright. Say plainly that
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

Report `conflicts` in every summary, in one line when there is nothing to say:

- `hadConflicts: false` — "no conflict with the base branch". Say it; silence
  reads as "nobody checked".
- `resolved: true` — name the files from `files` and say what `checks` ran. The
  rounds that followed reviewed this merge.
- `hadConflicts: true, resolved: false` — status is `conflicts-unresolved` and no
  round ran. Lead with that and quote the summary: the PR needs a person before
  the loop is worth running.
- `hadConflicts: null` — the forge was still computing after the retries, so the
  answer is unknown. Say that, not "no conflict".
- `conflicts: null` — the conflict agent failed, so nobody checked. The rounds ran
  anyway. Say so plainly rather than leaving it out.

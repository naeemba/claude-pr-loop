---
description: Uncapped re-review after fix commits — verify each fix, resolve the thread, catch what the fixes broke
argument-hint: <pr-number>
---

On PR #$ARGUMENTS there are new commits fixing earlier findings. Re-review.
Run the review yourself with the fan-out below. Do NOT delegate to the
`code-review` skill: its output is capped (4 findings at `medium`, 8 at `high`)
and it cuts convention and structure findings first, so most of what this
command looks for can never reach the author.

Three jobs, in this order:

1. **Verify each open thread.** Does the fix actually resolve what was asked —
   not "a commit touched that file", but the behaviour or structure the comment
   named.
2. **Review the new commits** for what they broke or introduced, using every
   angle below.
3. **Close the loop.** Reply on each resolved thread naming the commit, then
   resolve it.

## Fetching the open threads

Get them with `~/.claude/scripts/pr-unresolved-threads.sh $ARGUMENTS` (run
inside the repo) — it paginates GraphQL `reviewThreads` and prints only
unresolved threads, with the thread ids `resolveReviewThread` needs. The REST
comments endpoint carries neither resolution state nor thread ids; do not use
it.

A thread whose file was renamed or deleted by the fix still counts. Its `line`
comes back `null` and GitHub marks it outdated — that is what a good fix looks
like, not a reason to skip it. Follow the code to where it went.

## No cap

There is no limit on the number of findings or comments. Never trim to a
top-N, never sample the diff, never drop a real finding because the list is
long. The only thing that shrinks the list is deduplication:

- **One comment per root cause.** A rule broken in twelve files is ONE comment,
  on the clearest instance, listing the other eleven paths inside it — each
  marked in-scope or out-of-scope per the section below.
- One root cause often trips several angles. Post it once under the most
  specific angle and cross-reference the others in that same comment.
- Every finding that survives verification gets posted, `nit` included.

## Coverage — shard the new commits

Diff the fix commits against the previously reviewed sha, not the whole PR.
Group the changed files into shards of at most 15 along real seams (schema,
repository, logic, routes, components, tests) and run EVERY angle over EVERY
shard, one agent per (angle × shard), in parallel. Each agent returns
candidates as `file`, `line`, `summary`, `failure_scenario`, and the angle that
flagged it.

A fix that moved a lot of code counts as new code. Review the destination, not
just the diff of the move.

## Angles

### 1. Correctness
Bugs, side effects, broken paths, missing guards, stale state. A fix that moved
or extracted code and dropped a check on the way. Setup/teardown asymmetry in
tests. Config defaults flipped. Run this angle to completion before judging
anything below.

### 2. Existing patterns
The fix must not drift from the canonical reference or reintroduce something
that already exists. Name the reference file. Flag divergence in layout,
naming, error handling, response envelope, validation, wiring and test style.

**No reinvention.** A fix must not add a helper, util, type, schema mapping,
formatter, constant or route string that already exists — including one this
very PR added a few commits ago.

**Precedent is not a defence.** When a fix copies a pattern that is itself
wrong, flag the fix *and* name the precedent.

### 3. Structure & layering
Walk schema → repository/dao → logic → route/handler → frontend.

- **Layer placement.** Query code → the repository. Orchestration → logic. Pure
  computation → its own module. HTTP → the handler. Presentation → the
  frontend.
- **One entity per dao/schema (HARD rule).** One `pgTable` per schema file; a
  dao importing two schema mappings is a violation however it is named.
- **One concern per file.** A file exporting several unrelated schemas, or one
  section per domain value, is a split — name the files it becomes.
- **Util placement.** No helper or constant defined inline in a route or
  component. Name the destination.
- **Types.** Flag a type that re-spells an existing shape, inline anonymous
  object types that want a name, and a param type duplicating a schema.

### 4. Frontend layout & shared primitives
- Page-specific components in `src/features/<feature>/components/`, never a
  `_components/` folder beside the route. Shared by two features → the shared
  components directory.
- Flag any component defined inside another component's file.
- Form controls go through the project's own wrappers, which wrap the library
  component. Flag a raw `ui/*` import outside that folder, a hand-rolled
  input/select/checkbox, and an inline `<input>`/`<select>` in a feature.
- Every in-app URL comes from the shared routes module.

### 5. Names in full
`entityRow` not `e`, `documentKind` not `dk`. Single letters only in a one-line
lambda over an obvious collection. Check the fix commits especially — a rushed
fix is where short names get reintroduced.

### 6. Test value, not test count
For every test file the fixes touch, ask what breaks if the assertion is
deleted. Flag tests that check a label exists, re-assert a constant, or restate
the implementation. Name the behaviour the test should pin instead. A fix that
changed behaviour and left its tests untouched is a finding.

### 7. Reuse, simplification, dead code
Redundant or derivable state, copy-paste with variation, deep nesting, and code
the fixes orphaned — a file, export, type or migration nothing references any
more. Deleting what a refactor left behind is part of the fix.

## When the rule isn't written down

- Post the finding anyway, and add one line proposing where to record it —
  `AGENTS.md`, or the nearest `CLAUDE.md`. Otherwise the same comment comes
  back next PR.
- A taste issue a linter could enforce gets ONE comment proposing the eslint
  rule, not one per occurrence. If an earlier round already asked for the rule,
  check the config actually has it.

## Verify before posting

Every candidate goes to a verifier agent with the diff, the relevant files, and
the candidate. It returns exactly one of **CONFIRMED / PLAUSIBLE / REFUTED**.
Keep CONFIRMED and PLAUSIBLE; drop REFUTED. A structure candidate is verified
against the repo as it now stands — does the destination folder or wrapper
exist, is the claim still true after the fix commits moved things.

Verify the *fix claims* the same way. A reply saying "fixed in `<sha>`" is a
claim, not evidence: open the file at that sha and check. A fix that changed
the symptom and left the cause is not fixed.

## Scope — every finding is in-scope or out-of-scope

**in-scope** — the PR touched this file, OR the PR is what made it wrong (a
rename that left a caller stale, a helper the PR extracted while half the
callers still hand-roll it, a convention the PR introduced and applied
inconsistently *within its own diff*). Fix in this PR.

**out-of-scope** — the problem predates the PR and the PR did not make it
worse. Post it, do not fix it here. At the end of the review, collect every
out-of-scope finding into ONE follow-up issue (`gh issue create`) and link that
issue from the review summary.

Where a rule is broken in files the PR touched *and* files it did not: post one
comment on a changed instance, fix those, and list the unchanged paths inside
the same comment marked out-of-scope. "The rest of the repo does not follow the
new convention yet" is always out-of-scope — introducing a convention does not
oblige this PR to sweep the codebase.

In-scope findings carry the severity tag alone. Out-of-scope findings add
`[out-of-scope]` after it:

`**[medium]** [out-of-scope] The reminders form hand-rolls its select…`

## Severity — tag every NEW finding

Every new comment opens with a bold severity tag, then the finding:

`**[blocker]** The counter key is attacker-controlled, so one IP mints…`

| Tag | Means | The test |
|---|---|---|
| `blocker` | Merging ships this to users. Data loss, money, security, or a broken user path. | Would you roll back for it? |
| `high` | Real defect on a path production reaches, but bounded or recoverable. | Will it fire without anyone doing anything unusual? |
| `medium` | Real defect that needs a specific trigger — rare input, a config override, a caller that doesn't exist yet. Or a structure/pattern violation that will cost real work later. | Reachable, but something has to change first. |
| `low` | Latent, or an inaccurate comment/doc on load-bearing logic. | Nothing behaves wrongly today. |
| `nit` | Taste. Naming, phrasing, formatting. | Nothing happens if it is never fixed. |

- Severity is **reachability × blast radius**. A clever bug on a dead path is
  `low`.
- Anything above `medium` names the input or sequence that reaches it.
- **Severity is never a filter**, and never a resolution gate: a `nit` gets
  posted, a `blocker` whose fix works gets resolved.
- Severity and scope are independent. A `blocker` in an untouched file is
  still out-of-scope — it goes in the follow-up issue, loudly.
- When torn between two tags, take the lower one.

Re-review specifics:

- **Confirmation replies carry no tag.** "Verified fixed in `<sha>`" is not a
  finding.
- **A still-unfixed issue keeps its original tag**, unless the partial fix
  genuinely changed how reachable it is. If it did, restate the tag and say
  what moved it — "was `high`, now `low`: the fallback bounds it to one window".
- **A fix that introduces a worse problem than it solved is at least `high`**,
  and say so on the original thread, not only on a new one.

## Posting

- **Resolved threads:** reply on the thread naming the commit and what you
  checked, then resolve it with `resolveReviewThread` using the id from the
  script.
- **Unresolved threads:** reply saying what is still missing, and leave the
  thread open.
- **New findings:** inline comments. Prefer
  `mcp__github_inline_comment__create_inline_comment`; otherwise
  `gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/comments` with `commit_id`,
  `path`, `line` and `side: RIGHT`. For a finding about a file rather than a
  line, use `subject_type: file`.

End with a count per tag for the new findings, highest first, split in-scope /
out-of-scope, plus how many old threads you resolved, how many you left open,
how many findings were deduped into another comment, and a link to the
follow-up issue holding the out-of-scope ones.

## Report-only mode

When the invocation says REPORT-ONLY: post nothing, resolve nothing and open no
issue — no comments, replies, reviews or thread resolutions. Return instead:
every new finding (path, line, tag, full body), grouped in-scope / out-of-scope, and for each open thread whether it is
fixed, with the evidence. Everything else is identical.

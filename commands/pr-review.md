---
description: Uncapped PR review — bugs, structure, frontend layout, naming, test value; one comment per root cause
argument-hint: <pr-number>
---

Review PR #$ARGUMENTS. Run the review yourself with the fan-out below. Do NOT
delegate to the `code-review` skill: its output is capped (4 findings at
`medium`, 8 at `high`) and it cuts convention and structure findings first, so
on a large PR most of what this command looks for can never reach the author.

## No cap

There is no limit on the number of findings or comments. Never trim to a top-N,
never sample the diff, never drop a real finding because the list is long. The
only thing that shrinks the list is deduplication:

- **One comment per root cause.** A rule broken in twelve files is ONE comment,
  posted on the clearest instance, listing the other eleven paths inside it —
  each marked in-scope or out-of-scope per the section below.
- One root cause often trips several angles below. Post it once under the most
  specific angle and cross-reference the others in that same comment.
- Every finding that survives verification gets posted, `nit` included.

## Coverage — shard the diff

Read `gh pr diff $ARGUMENTS --name-only` first. Group the changed files into
shards of at most 15, split along real seams (schema, repository/dao, logic,
routes, components, tests). Run EVERY angle below over EVERY shard — one agent
per (angle × shard), in parallel. A 100-file PR gets ~7 shards, not one agent
skimming everything. Each agent returns candidates as `file`, `line`,
`summary`, `failure_scenario` (the concrete cost: what breaks, what is
duplicated, what gets harder), and which angle flagged it.

## Angles

### 1. Correctness
Bugs, side effects, broken paths, missing guards, state that can go stale.
Moved or extracted code that dropped a check. Setup/teardown asymmetry in
tests. Config defaults flipped. Run this angle to completion before judging
anything below — a clean structure pass is not a clean review.

### 2. Existing patterns
Find the closest EXISTING feature of the same kind, take the cleanest as the
canonical reference, name it in the review, and flag every divergence: file and
folder layout, naming, error handling, response envelope, validation, wiring,
test style. The PR should read as if the reference's author wrote it.

**No reinvention.** The PR must not add a helper, util, type, schema mapping,
formatter, constant or route string that already exists. Name the existing
thing to reuse.

**Precedent is not a defence.** The reference says what the codebase does, not
what it should do. When the PR copies a pattern that is itself wrong, flag the
PR *and* name the precedent to fix. "It matches the sibling" is not a reason to
stay quiet.

### 3. Structure & layering
Walk schema → repository/dao → logic → route/handler → frontend.

- **Layer placement.** Query code → the repository. Orchestration → logic. Pure
  computation → its own module. HTTP → the handler. Presentation → the
  frontend. Flag logic inlined in a handler, DB access outside the repository,
  and business decisions (thresholds, magic numbers, "fetch everything") leaking
  into transport.
- **One entity per dao/schema (HARD rule).** A dao file maps and queries exactly
  one `db/schema/<entity>` table; importing two schema mappings is a violation
  however the class is named. Cross-entity reads fan out from logic; an atomic
  cross-entity write composes `tx`-accepting dao methods in logic. One
  `pgTable` per schema file.
- **One concern per file.** A file exporting several unrelated schemas, or one
  section per domain value (per species, per document kind, per provider), is a
  split — name the files it becomes. It is already too big if adding the next
  value grows it.
- **Util placement.** No helper or constant defined inline in a route or
  component. General → a shared util; feature-specific → colocated. Name the
  destination.
- **Types.** Flag a type that re-spells an existing shape (derive with
  `Pick`/`Omit`/`z.infer`), inline anonymous object types that want a name, and
  a param type duplicating a validation schema.

### 4. Frontend layout & shared primitives
- Page-specific components live in `src/features/<feature>/components/`, never
  in a `_components/` folder beside the route. Used by two features → the
  shared components directory.
- Flag any component defined inside another component's file.
- Form controls go through the project's own wrappers (the `components/form`
  layer), which wrap the library component. Flag a raw `ui/*` import outside
  that folder, a hand-rolled input/select/checkbox, and an inline
  `<input>`/`<select>` in a feature.
- Every in-app URL comes from the shared routes module. Flag a hardcoded path
  in a link, a `router.push`, or a revalidate call.

### 5. Names in full
No abbreviated identifiers: `entityRow` not `e`, `documentKind` not `dk`,
`frequency` not `f`. Single letters only in a one-line lambda over an obvious
collection. Flag renames that shortened a meaningful name.

### 6. Test value, not test count
For every test file the PR touches, ask what breaks if the assertion is
deleted. Flag tests that only check a label exists, re-assert a constant, or
restate the implementation. Name the behaviour the test should pin instead —
the branch, the edge case, the thing a user would notice. "Tests added" is not
coverage. Then flag branches the PR introduces with no test at all.

### 7. Reuse, simplification, dead code
Redundant or derivable state, copy-paste with slight variation, deep nesting,
code left behind that nothing calls, a dependency added for what a few lines
already do. Name the simpler form that does the same job.

## When the rule isn't written down

- Post the finding anyway, and add one line proposing where to record it —
  `AGENTS.md`, or the nearest `CLAUDE.md`. An unwritten convention is missed
  every round until it is written; recording it is what stops the same comment
  coming back next PR.
- A taste issue a linter could enforce (nested ternaries, banned imports,
  naming) gets ONE comment proposing the eslint rule, not one comment per
  occurrence.

## Verify before posting

Every candidate goes to a verifier agent with the diff, the relevant files, and
the candidate. It returns exactly one of **CONFIRMED / PLAUSIBLE / REFUTED**.
Keep CONFIRMED and PLAUSIBLE; drop REFUTED. A structure candidate is verified
against the repo as it exists — does the destination folder or wrapper actually
exist, is the reference file really the cleaner one, is the claim true after
this PR's own moves. Never post a finding about a line the PR did not touch
unless the PR is what made it wrong.

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

## Severity — tag every finding

Every comment opens with a bold severity tag, then the finding:

`**[blocker]** The counter key is attacker-controlled, so one IP mints…`

| Tag | Means | The test |
|---|---|---|
| `blocker` | Merging ships this to users. Data loss, money, security, or a broken user path. | Would you roll back for it? |
| `high` | Real defect on a path production reaches, but bounded or recoverable. | Will it fire without anyone doing anything unusual? |
| `medium` | Real defect that needs a specific trigger — rare input, a config override, a caller that doesn't exist yet. Or a structure/pattern violation that will cost real work later. | Reachable, but something has to change first. |
| `low` | Latent, or an inaccurate comment/doc on load-bearing logic. | Nothing behaves wrongly today. |
| `nit` | Taste. Naming, phrasing, formatting. | Nothing happens if it is never fixed. |

- Severity is **reachability × blast radius** — never how subtle the bug was or
  how much you want it fixed. A clever bug on a dead path is `low`.
- Anything above `medium` names the input or sequence that reaches it, in the
  comment itself. A `blocker` with no concrete path is a `medium` oversold.
- **Severity is never a filter.** It orders the list; it does not shorten it.
- Severity and scope are independent. A `blocker` in an untouched file is
  still out-of-scope — it goes in the follow-up issue, loudly.
- When torn between two tags, take the lower one.

## Posting

Post each finding as an inline comment on the PR. Prefer
`mcp__github_inline_comment__create_inline_comment`; if it is not available,
use `gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/comments` with `commit_id`,
`path`, `line` and `side: RIGHT`. When the finding is about a file rather than
a line (layout, a file that should be split), post with `subject_type: file`.
Include a suggestion block only when it fully fixes the issue.

End with a count per tag, highest first, split in-scope / out-of-scope, plus
how many findings were deduped into another comment and a link to the follow-up
issue holding the out-of-scope ones.

## Report-only mode

When the invocation says REPORT-ONLY: post nothing and open no issue — no
comments, reviews or replies — and return every finding instead, grouped
in-scope / out-of-scope (repo-relative path, line, severity
tag, full comment body). Everything else is identical.

# The review standard

Read by `/pr-review`, `/pr-rereview`, `/mr-review` and `/mr-rereview`. It says
what to look for and how to grade it. Each command says what to fetch, how to
shard it, and how to post — that is all they add.

**"the change"** below means the pull request or merge request under review.
On GitLab the command file gives the `glab` equivalent of every `gh` command
named here.

Never delegate this to the `code-review` skill: its output is capped (4 findings
at `medium`, 8 at `high`) and it cuts convention and structure findings first,
so on a large change most of what this standard looks for can never reach the
author.

## No cap

There is no limit on the number of findings or comments. Never trim to a top-N,
never sample the diff, never drop a real finding because the list is long. The
only thing that shrinks the list is deduplication:

- **One comment per root cause.** A rule broken in twelve files is ONE comment,
  posted on the clearest instance, listing the other eleven paths inside it —
  each marked in-scope or out-of-scope per the section below.
- One root cause often trips several angles. Post it once under the most
  specific angle and cross-reference the others in that same comment.
- Every finding that survives verification gets posted, `nit` included.

## Angles

Every angle runs over every shard it can find something in. "Running the
angles" below says how angles are grouped into agents and which shards each
group gets. Each agent returns candidates as `file`, `line`, `summary`,
`failure_scenario` (the concrete cost: what breaks, what is duplicated, what
gets harder), and which angle flagged it.

### 1. Correctness
Bugs, side effects, broken paths, missing guards, state that can go stale.
Moved or extracted code that dropped a check on the way. Setup/teardown
asymmetry in tests. Config defaults flipped. Run this angle to completion before
judging anything below — a clean structure pass is not a clean review.

### 2. Existing patterns
Find the closest EXISTING feature of the same kind, take the cleanest as the
canonical reference, name it in the review, and flag every divergence: file and
folder layout, naming, error handling, response envelope, validation, wiring,
test style. The change should read as if the reference's author wrote it.

**No reinvention.** The change must not add a helper, util, type, schema
mapping, formatter, constant or route string that already exists. Name the
existing thing to reuse.

**Precedent is not a defence.** The reference says what the codebase does, not
what it should do. When the change copies a pattern that is itself wrong, flag
the change *and* name the precedent to fix. "It matches the sibling" is not a
reason to stay quiet.

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
For every test file the change touches, ask what breaks if the assertion is
deleted. Flag tests that only check a label exists, re-assert a constant, or
restate the implementation. Name the behaviour the test should pin instead —
the branch, the edge case, the thing a user would notice. "Tests added" is not
coverage. Then flag branches the change introduces with no test at all.

### 7. Reuse, simplification, dead code
Redundant or derivable state, copy-paste with slight variation, deep nesting,
code left behind that nothing calls, a dependency added for what a few lines
already do. Name the simpler form that does the same job.

### 8. Security
Every changed path that touches input, identity or secrets. Not a checklist to
tick — name the request that gets through.

- **Input reaching a query, a shell, a path or the DOM.** An interpolated SQL
  string, a template string handed to a shell, a user-supplied filename joined
  onto a base directory, `dangerouslySetInnerHTML` on anything a user typed.
  Name the parameterised or escaped form the codebase already uses elsewhere.
- **Authorisation, not just authentication.** A route or server action that
  checks a session exists and never checks the session owns the row it reads or
  writes. Name the id another user passes to reach someone else's data.
- **Secrets and leakage.** A hardcoded key or token, a secret read into a client
  bundle (`NEXT_PUBLIC_*` or the project's equivalent), an error response or log
  line that hands back a stack trace, a query, or PII.
- **Missing limits on anything reachable without a login.** No rate limit, no
  size or type cap on an upload, no page cap on a public list endpoint.

The severity rules apply unchanged: above `medium` names the concrete request,
so "this could be unsafe" with no path is a `medium` oversold — drop it to
`medium`, not to `low`.

### 9. Performance on the paths the change adds
Only what the diff introduces, against the data this project actually holds.
Not micro-optimisation.

- **A query per item.** A `map` or `for` over rows that calls the dao once per
  element. Name the single batched call that replaces it — `inArray`, a join,
  one `where … in`.
- **Unbounded reads.** A select with no `limit` and nothing narrowing it, a list
  endpoint with no pagination, a filter on a column with no index. Say roughly
  how many rows that is today and what it becomes.
- **Work repeated every render or every request.** A value recomputed on each
  render that never changes, a fetch inside a component that reruns whenever the
  parent does, a sequential `await` chain whose calls do not depend on each
  other.
- **Long work inline in a handler** that belongs in a background job, so the
  request holds the connection open while it runs.

## Running the angles

One agent per angle per shard is what made a big review cost 130 finders and
400 verifiers. The rules below keep every angle and every finding, and stop the
same code being read dozens of times.

### Shards — by diff size, not file count

Aim for about 800 changed lines per shard, split along real seams (schema,
repository/dao, logic, routes, components, tests). Twenty files of one-line
import changes are one shard, not two. One 1,500-line file is a shard on its
own.

Leave out lockfiles, generated files, snapshots and build output. Migrations
stay in, in the schema shard — a migration that drops a column loses data.

### Four groups per shard, not nine agents

| Group | Angles | Model |
|---|---|---|
| A | 1 Correctness | `opus` |
| B | 8 Security, 9 Performance | `opus` |
| C | 2 Existing patterns, 3 Structure, 5 Names, 7 Reuse | `sonnet` |
| D | 4 Frontend layout, 6 Test value | `sonnet` |

Correctness gets an agent to itself so nothing else competes for its attention.
Each agent in a group works through every angle it holds in full, one after
another, and tags each candidate with the angle that found it. Pass the model
on the agent call; the finders do not inherit the session's.

### Run a group only where it can find something

| Shard kind | Groups |
|---|---|
| Components, pages | A, B, C, D |
| Repository/dao, logic, routes, server actions, scripts | A, B, C, D |
| Tests only | A, C, D |
| Schema, config, anything else | A, B, C |

Group D runs on server code too. Angle 6 flags a new branch with no test, and
that branch lives in logic, not in a test file. Angle 4 flags a hardcoded path
in a revalidate call, and that call lives in a server action.

A shard mixing kinds gets every group any of its kinds gets. When unsure, run
the group.

### Find the reference feature once

Before any finder starts, find the canonical reference for angle 2 — one per
kind of thing the change adds (a route, a form, a dao) — and hand those names to
every group C agent. They do not search for it again. One that thinks the
reference is wrong for its shard says so in a candidate.

### Say the cost before starting

Print the plan first: shard count, groups per shard, finder agents, and
verifier agents (at least one per shard, see below). Add them up. Above 60 in
total, stop and ask before launching.

A `/pr-loop` or `/mr-loop` round is different. It runs as a subagent, and a
subagent has no tool to launch more agents. So the round launches nothing and
prints no agent plan. It works through the shards and groups itself, one after
another, then checks its own candidates. Its summary says it ran as a single
agent, so nobody reads it as a full sharded review.

## When the rule isn't written down

- Post the finding anyway, and add one line proposing where to record it —
  `AGENTS.md`, or the nearest `CLAUDE.md`. An unwritten convention is missed
  every round until it is written; recording it is what stops the same comment
  coming back next time.
- A taste issue a linter could enforce (nested ternaries, banned imports,
  naming) gets ONE comment proposing the eslint rule, not one comment per
  occurrence.

## Verify before posting

**Merge first, then verify.** Group the raw candidates by root cause before any
verifier runs. The same missing check found by three angles in ten files is one
candidate listing all ten places, and it is verified once.

**One verifier per shard, not per candidate.** Give it the shard's diff, the
relevant files, and every merged candidate whose clearest instance sits in that
shard. For a changed function, the relevant files include its callers — a change
that reads as self-contained in the diff is the one whose call sites are all
outside it. It returns exactly one of **CONFIRMED / PLAUSIBLE / REFUTED** per
candidate. Keep CONFIRMED and PLAUSIBLE; drop REFUTED. Give a shard one
verifier per about 15 candidates: 45 candidates get three verifiers, not two.
Verifiers run on `opus`.

**Nits and names skip the verifier.** A `nit`, an angle-5 name, or an eslint-rule
proposal is checked by looking at the line. Do that yourself and drop the ones
that are wrong. Everything else goes to a verifier.

A structure candidate is verified
against the repo as it exists — does the destination folder or wrapper actually
exist, is the reference file really the cleaner one, is the claim true after
this change's own moves. Never post a finding about a line the change did not
touch unless the change is what made it wrong.

## Scope — every finding is in-scope or out-of-scope

**in-scope** — the change touched this file, OR the change is what made it wrong
(a rename that left a caller stale, a helper it extracted while half the callers
still hand-roll it, a convention it introduced and applied inconsistently
*within its own diff*). Fix it here.

**out-of-scope** — the problem predates the change and the change did not make
it worse. Post it, do not fix it here. It leaves the review and becomes later
work, per the section below.

Where a rule is broken in files the change touched *and* files it did not: post
one comment on a changed instance, fix those, and list the unchanged paths
inside the same comment marked out-of-scope. "The rest of the repo does not
follow the new convention yet" is always out-of-scope — introducing a convention
does not oblige this change to sweep the codebase.

In-scope findings carry the severity tag alone. Out-of-scope findings add
`[out-of-scope]` after it:

`**[medium]** [out-of-scope] The reminders form hand-rolls its select…`

## Out-of-scope findings leave twice — the issue, then the board

An out-of-scope finding is not this change's job, so it needs somewhere to live
that outlasts it. One place always, a second when a board is set up, in this
order, once the review is posted.

**1. One issue.** Collect every out-of-scope finding into ONE `gh issue create`
on this repo, grouped by severity, highest first. Link it from the review
summary.

**2. One board card per finding — only when a card script is configured.**
Check `printenv PR_LOOP_CARD_SCRIPT`. Empty means no board: skip this step,
create no cards, and say "no card script configured" in the summary. Otherwise
it names an executable that files one card on the project's board; a leading
`~/` in it means the home directory, which the quoted form below expands. For
each out-of-scope finding, run it from inside the repo:

    "${PR_LOOP_CARD_SCRIPT/#\~/$HOME}" \
      --title "<the finding's one-line summary>" \
      --notes "<the comment body, the concrete cost, then the issue and review links>" \
      --priority <from the table>

Pass those flags and nothing else; the command file adds `--remote` where the
forge needs it. Once per finding, not once per review — the issue is the
digest, the board is the work queue. The findings are already deduped to one
per root cause, so this is a handful of cards, not one per occurrence.

| Severity | Card priority |
|---|---|
| `blocker` | `urgent` |
| `high` | `high` |
| `medium` | `medium` |
| `low`, `nit` | `low` |

Every card's notes end with the issue URL and the review URL. A card picked up
weeks later must still say where it came from without anyone hunting for it.

If the script fails or reports it has nowhere to file the card (the repo has no
board, say), stop creating cards and say so in the summary, quoting its message.

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

## Report-only mode

When the invocation says REPORT-ONLY: post nothing, open no issue and create no
board cards — no comments, reviews, replies or thread resolutions — and return
every finding instead, grouped in-scope / out-of-scope (repo-relative path,
line, severity tag, full comment body). Everything else is identical.

# claude-pr-loop

Claude Code slash commands that review a change, fix what the review found,
re-review the fixes, and repeat until it's clean — each round in a fresh
context, driven by a workflow script that decides when to stop.

Works on **GitHub pull requests** and **GitLab merge requests**.

```
/pr-loop 512      # GitHub PR #512
/mr-loop 512      # GitLab MR !512
```

That's it. It reviews the change, pushes fix commits, re-reviews its own fixes,
and stops when nothing above `low` is left unresolved.

---

## Why this exists

Claude Code ships a `code-review` skill. In my use it caps how many findings it
returns per effort level, and when it trims, convention and structure findings
are the first to go. On a 60-file change that means most of what you'd actually
want flagged never reaches the author. (The exact caps aren't documented and may
change between versions — this is observed behaviour, not a published number.)

These commands remove the cap. The only thing that shortens the list is
deduplication — one comment per root cause, not one per occurrence.

The second problem is context. A single session that reviews a change, then
fixes it, then judges its own fixes, is grading its own homework with all its
earlier reasoning still in the window. It will find its own patch convincing. So
each round here runs in a **fresh subagent that reads only the change**, and the
decision to continue is made by the script from counts, never by the reviewer's
opinion of its own work.

## What's in here

| File | Role |
|---|---|
| `review/standard.md` | **The review standard.** What to look for, how to verify it, how to grade it. All four review commands read this one file. |
| `commands/pr-review.md` | Initial review. Shards the diff, runs every angle over every shard in parallel, verifies each candidate, posts inline comments. |
| `commands/pr-address.md` | Fixes valid comments, rejects invalid ones with a reason. Replies with the commit SHA. Never resolves threads. |
| `commands/pr-rereview.md` | Verifies each fix against the code at that SHA, resolves what's genuinely fixed, reviews what the fixes broke. |
| `commands/pr-conflicts.md` | Merges the base branch into a conflicting PR and resolves by hand. Never rebases. The loop runs it before round 1. |
| `commands/pr-loop.md` | Chains all of them via the workflow. |
| `commands/mr-*.md` | The GitLab five. Each reads its `pr-` twin and translates `gh` to `glab`; nothing about the review itself changes. |
| `workflows/pr-loop.js` | The loop engine, shared by both forges. Spawns one fresh subagent per role per round and decides when to stop. |
| `scripts/pr-unresolved-threads.sh` | Prints a PR's unresolved review threads as JSON. |
| `scripts/mr-unresolved-threads.sh` | The same for a GitLab MR. |
| `scripts/gitlab-remote.sh` | Works out which remote is the GitLab one, for repos that keep GitHub on `origin` and GitLab on a second remote. |
| `install.sh` | Links all of the above into `~/.claude`, one file at a time. |
| `tests/`, `*.test.sh` | Self-checks for the workflow, the install script and the GitLab thread lister. |

The review, re-review, address and conflicts commands work standalone. You don't need the loop to use them.

## Install

Requires [Claude Code](https://claude.com/claude-code) with workflows available,
`jq`, plus `gh` (authenticated) for GitHub and `glab` for GitLab.

```bash
git clone https://github.com/naeemba/claude-pr-loop.git
cd claude-pr-loop
./install.sh
```

`install.sh` symlinks each command into `~/.claude/commands/`, the workflow into
`~/.claude/workflows/`, the standard into `~/.claude/review/` and the helper
scripts into `~/.claude/scripts/`. Links point back at the checkout, so `git
pull` is the update. Anything of yours already in those folders stays; a real
file where one of these goes is moved aside as `<name>.backup-<timestamp>`.
Re-running it also removes links to files this checkout no longer has.

The paths matter: the commands read `~/.claude/review/standard.md` by name, and
the workflow reads the command files out of `~/.claude/commands`.

**Why not a Claude Code plugin?** A plugin can ship commands and workflows, but
its commands are always namespaced — `/claude-pr-loop:pr-loop`, never `/pr-loop`
([plugin components](https://code.claude.com/docs/en/plugins/components.md)).
Plain user commands keep the short names, and the command files keep reading
each other at fixed paths.

Then, from inside any repo:

```
/pr-review 512      # review only
/pr-address 512     # fix the open comments
/pr-rereview 512    # verify the fixes, resolve the threads
/pr-conflicts 512   # merge the base in if it conflicts
/pr-loop 512        # all of the above, on repeat
```

and the `mr-` five for GitLab.

## Configuration

Everything is optional. Environment variables go in the `env` block of
`~/.claude/settings.json`, so every session and subagent sees them.

| Setting | Default | What it does |
|---|---|---|
| `PR_LOOP_CARD_SCRIPT` | unset | Path to an executable that files one card on your project board. When set, each out-of-scope finding also becomes a card. It is called as `"$PR_LOOP_CARD_SCRIPT" --title <t> --notes <n> --priority <urgent\|high\|medium\|low>`, plus `--remote <name>` on GitLab. Unset, the review files the follow-up issue only and says so. |
| `GITLAB_REMOTE` | found | The git remote that is the GitLab one. Normally worked out by `gitlab-remote.sh`. |
| workflow options | see [Options](#options) | Per run: `/pr-loop {"pr": 512, "stopAt": "nit"}`. |

### Models per role

| Role | Runs | Model and effort |
|---|---|---|
| Review, re-review rounds | `/pr-review`, `/pr-rereview` | `opus`, high — pinned, so a cheaper session can't downgrade the rounds that decide what's wrong. `reviewModel` overrides. |
| Fix rounds | `/pr-address` | The session's own model and effort. `fixModel` overrides. |
| Conflict step | `/pr-conflicts` | The session's own. `conflictsModel` overrides. |
| Standalone `/pr-review`, `/pr-rereview` | frontmatter | `opus`, high. |
| Standalone `/pr-address`, `/pr-conflicts` | frontmatter | `sonnet`, low. |
| Finders inside a standalone review | `review/standard.md` | Correctness and security/performance on `opus`; patterns, structure, names, reuse, layout and tests on `sonnet`. Verifiers on `opus`. |
| `/pr-loop` itself | — | The session that typed it. |

The same holds for the `mr-` commands.

## GitLab

`/mr-loop` runs the same `workflows/pr-loop.js` with `forge: "gitlab"`. That one
argument swaps which command files each round executes and which script lists the
open threads. Rounds, counts, the severity floor and every stopping rule are
identical.

Two practical differences:

**The number is the MR's project-scoped `iid`** — the `!123` a human sees, not
the global id.

**The GitLab remote is found, not assumed.** Plenty of repos keep GitHub on
`origin` and GitLab on a second remote. `gitlab-remote.sh` picks the one whose
URL actually says gitlab, and exports the host and the URL-encoded project path
that every `glab api` call needs. Guess wrong and a review posts nothing, or a
fix pushes to a mirror the merge request can't see. Set `GITLAB_REMOTE` yourself
to override it.

`/mr-loop` checks `glab auth status --hostname "$GITLAB_HOST"` once before
starting. The `--hostname` is what makes that a real check — bare `glab auth
status` reports on every host it knows, so being logged in to `gitlab.com` prints
green while a self-hosted host behind a dropped VPN is the thing actually
failing.

## How the loop decides to stop

`pr-loop.js` runs up to 6 rounds. After each review round it asks the subagent
for counts, then decides for itself:

- **`conflicts-unresolved`** — the conflict step found a conflict it would not
  guess at and left it open. No round ran; a person has to pick a side.
- **`converged`** — zero unresolved threads. Done.
- **`floor-addressed`** — everything left is at or below the severity floor
  (default `low`). The final fix round still runs and takes that tail; what
  doesn't run is another re-review to check it. Verifying a nit costs a review +
  fix agent pair, which is more than the nit is worth.
- **`stopped-at-floor`** — nothing above the floor, and nothing a fix round could
  touch either: every remaining thread is waiting on a person.
- **`no-progress`** — a fix round neither fixed nor rejected anything. Usually
  the only threads left are a human's comments that a previous round already
  answered and deliberately won't re-argue.
- **`max-rounds-hit`** — 6 rounds elapsed.
- **`agent-error`** — a round's agent failed three times. The result still
  lists every commit earlier rounds pushed.

Four details that matter more than they look:

**An untagged thread always counts as above the floor.** A teammate's plain
comment carries no severity tag, and it must never be the thing that ends the
loop just because nobody labelled it.

**A thread waiting on a person doesn't count at all.** Someone else raised it,
and the last comment on it is a reply from our side — the ball is in their court.
Left in the count, it spawns a fix agent with nothing to do every remaining
round. Every status reports these separately in `blockedOnHuman`. A thread whose
last comment is *theirs* is not blocked: it's a finding, and the fix round owns
it.

**Convergence is derived, not self-reported.** The subagent reports raw counts —
how many comments it posted, how many threads the script printed. Whether that
means "clean" is computed by the workflow. A reviewer that could declare its own
work finished would.

**The last commits of a run have no review behind them.** On `floor-addressed`
the final fix agent is told it's last, and told to reject anything it can't fix
safely in a small diff — but if a `low` fix breaks a test, no round after it will
catch that. Read the final diff.

Because the floor makes severity load-bearing, a mislabelled finding has a real
cost: tag something `low` that's really `medium` and it gets fixed in that last
unverified round. That's a deliberate trade — it buys you roughly a round per
run. Raising `stopAt` raises what lands there, which is why the default is `low`.

### Options

Pass an object instead of a bare number:

| Option | Default | What it does |
|---|---|---|
| `stopAt` | `low` | The severity floor. `nit` only stops on a fully clean change. |
| `maxRounds` | `6` | The round cap. |
| `startAt: "rereview"` | — | Begin round 1 with `/pr-rereview`. For a change whose findings were already fixed elsewhere: without it, round 1 reviews the fixed head from scratch and the fix agent burns itself replying to duplicates it just made. |
| `worktree: true` | — | Run every round's agent in its own git worktree, so the loop never touches the branch you have checked out. |
| `reviewModel` | `opus` | Model for review rounds. `null`, `"session"` or `"inherit"` puts them on the session's model and effort. |
| `fixModel` | `inherit` | Model for fix rounds. |
| `conflictsModel` | `inherit` | Model for the conflict step. |
| `forge: "gitlab"` | `github` | Set by `/mr-loop`. Not optional there. |

### Conflicts first

Before round 1, one agent asks the forge whether the change conflicts with its
base. If it does, it merges the base in — never a rebase, which would drop every
inline thread — resolves by hand, runs the repo's checks and pushes. The rounds
then review the merge like any other commit. If it can't tell which side wins,
it aborts and the run stops with `conflicts-unresolved`.

## The review

`pr-review` reads the changed line count per file and packs it into shards of
about 800 changed lines along real seams (schema, repository, logic, routes,
components, tests). Each shard gets up to four finder agents — the angles are
grouped so the same code isn't read nine times — and one verifier. A big change
gets several shards, not one agent skimming everything. It prints the agent count
first and asks before going over 60.

Inside a `/pr-loop` round there is no fan-out: a subagent can't launch agents, so
the round works through the shards and groups itself and says so.

The angles, all of them in `review/standard.md`:

1. **Correctness** — bugs, missing guards, stale state, checks dropped during a
   move or extraction, setup/teardown asymmetry in tests.
2. **Existing patterns** — find the closest existing feature of the same kind,
   name it as the reference, flag every divergence. *Precedent is not a defence*:
   if the change copies a pattern that's itself wrong, flag both.
3. **Structure & layering** — query code in the repository, orchestration in
   logic, HTTP in the handler. One entity per dao/schema file.
4. **Frontend layout & shared primitives** — where components live, form controls
   through the project's own wrappers, no hardcoded in-app URLs.
5. **Names in full** — `documentKind`, not `dk`.
6. **Test value, not test count** — for every touched test, what breaks if you
   delete the assertion? "Tests added" is not coverage.
7. **Reuse, simplification, dead code** — derivable state, copy-paste with
   variation, a dependency added for what five lines already do.
8. **Security** — input reaching a query, a shell, a path or the DOM;
   authorisation and not just authentication; secrets and leakage; missing limits
   on anything reachable without a login. Name the request that gets through, not
   the category.
9. **Performance on the paths the change adds** — a query per item, unbounded
   reads, work repeated every render or request, long work inline in a handler.
   Only what the diff introduces; not micro-optimisation.

Candidates are merged by root cause, then each shard's **verifier agent** returns
CONFIRMED, PLAUSIBLE or REFUTED for each one against the repo as it actually stands. REFUTED gets
dropped. This is what stops the review inventing a violation of a convention the
repo doesn't have.

### Severity

Every comment opens with a tag: `blocker`, `high`, `medium`, `low`, `nit`.

Severity is **reachability × blast radius** — never how subtle the bug was or how
much the reviewer wants it fixed. A clever bug on a dead path is `low`. Anything
above `medium` has to name the input or sequence that reaches it in the comment
itself; a `blocker` with no concrete path is a `medium` oversold.

Severity orders the list. It never shortens it.

### Scope

Every finding is marked in-scope or out-of-scope. Out-of-scope means the problem
predates the change and the change didn't make it worse — it still gets posted,
but it's collected into one follow-up issue instead of being fixed here. "The
rest of the repo doesn't follow the new convention yet" is always out-of-scope;
introducing a convention doesn't oblige a change to sweep the codebase.

Out-of-scope findings then leave twice: one issue holding all of them as the
digest, and — when `PR_LOOP_CARD_SCRIPT` is set — one board card each as the
work queue. The fix rounds never touch them.

## Things you'll probably want to change

**Angles 3 and 4 are written for a specific stack** — Next.js-style
`src/features/<feature>/components/`, one Drizzle `pgTable` per schema file, a
`components/form` wrapper layer, dao/repository/logic/route layering. That
specificity is the point: a review that says "follow good structure" finds
nothing. Rewrite those two sections of `review/standard.md` for your own layout —
that's the main edit this repo expects you to make.

**`pr-loop.js` injects a `NO_ATTRIBUTION` instruction** telling every subagent
not to mention AI tooling in commits or replies. That's a personal preference.
Delete the constant and its two uses if you'd rather have AI-authored commits
labelled as such.

**`pr-address` never resolves threads, by design.** The fixer replies with a
commit SHA and leaves the thread open; only `pr-rereview` resolves, and only
after opening the file at that SHA and checking. An unverified "fixed"
disappearing from the unresolved list looks identical to a verified one.

**Report-only mode.** The review commands take a `REPORT-ONLY` instruction —
they post nothing, open no issue, resolve nothing, and return the findings
instead. Useful for a dry run on someone else's change.

**Edit in the checkout, not in `~/.claude`.** The installed files are links, so
an edit through either path changes the checkout — commit it there, or keep a
fork.

## Cost

The loop is not cheap. One round is a review fan-out (angles × shards, plus a
verifier per candidate) followed by a fix agent. A large change over several
rounds is a lot of tokens. Run `/pr-review` on its own first to see what you're
in for before reaching for `/pr-loop`.

## Tests

```bash
node --test tests/pr-loop.test.js
./install.test.sh
./scripts/mr-unresolved-threads.test.sh
```

None of them need a network, `gh` or `glab`.

## License

MIT

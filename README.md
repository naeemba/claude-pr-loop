# claude-pr-loop

Four Claude Code slash commands that review a pull request, fix what the review
found, re-review the fixes, and repeat until the PR is clean — each round in a
fresh context, driven by a workflow script that decides when to stop.

```
/pr-loop 512
```

That's it. It reviews PR #512, pushes fix commits, re-reviews its own fixes,
and stops when nothing above `low` is left unresolved.

---

## Why this exists

Claude Code ships a `code-review` skill. In my use it caps how many findings it
returns per effort level, and when it trims, convention and structure findings
are the first to go. On a 60-file PR that means most of what you'd actually want
flagged never reaches the author. (The exact caps aren't documented and may
change between versions — this is observed behaviour, not a published number.)

These commands remove the cap. The only thing that shortens the list is
deduplication — one comment per root cause, not one per occurrence.

The second problem is context. A single session that reviews a PR, then fixes
it, then judges its own fixes, is grading its own homework with all its earlier
reasoning still in the window. It will find its own patch convincing. So each
round here runs in a **fresh subagent that reads only the PR**, and the decision
to continue is made by the script from counts, never by the reviewer's opinion
of its own work.

## What's in here

| File | Role |
|---|---|
| `commands/pr-review.md` | Initial review. Shards the diff, runs 7 angles over every shard in parallel, verifies each candidate, posts inline comments. |
| `commands/pr-address.md` | Fixes valid comments, rejects invalid ones with a reason. Replies with the commit SHA. Never resolves threads. |
| `commands/pr-rereview.md` | Verifies each fix against the code at that SHA, resolves what's genuinely fixed, reviews what the fixes broke. |
| `commands/pr-loop.md` | Chains all three via the workflow. |
| `workflows/pr-loop.js` | The loop engine. Spawns one fresh subagent per role per round and decides when to stop. |
| `scripts/pr-unresolved-threads.sh` | Prints a PR's unresolved review threads as JSON. Required by `pr-address` and `pr-rereview`. |

The three review commands work standalone. You don't need the loop to use them.

## Install

Requires [Claude Code](https://claude.com/claude-code), `gh` (authenticated),
and `jq`.

```bash
git clone https://github.com/naeemba/claude-pr-loop.git
cd claude-pr-loop

mkdir -p ~/.claude/commands ~/.claude/workflows ~/.claude/scripts
cp commands/*.md      ~/.claude/commands/
cp workflows/*.js     ~/.claude/workflows/
cp scripts/*.sh       ~/.claude/scripts/
chmod +x ~/.claude/scripts/pr-unresolved-threads.sh
```

Or symlink them, if you keep your Claude config in a dotfiles repo:

```bash
ln -sf "$PWD"/commands/*.md  ~/.claude/commands/
ln -sf "$PWD"/workflows/*.js ~/.claude/workflows/
ln -sf "$PWD"/scripts/*.sh   ~/.claude/scripts/
```

Then, from inside any repo:

```
/pr-review 512      # review only
/pr-address 512     # fix the open comments
/pr-rereview 512    # verify the fixes, resolve the threads
/pr-loop 512        # all of the above, on repeat
```

## How the loop decides to stop

`pr-loop.js` runs up to 6 rounds. After each review round it asks the subagent
for three numbers, then decides for itself:

- **`converged`** — zero unresolved threads on the PR. Done.
- **`stopped-at-floor`** — everything left is tagged at or below the severity
  floor (default `low`). The remaining `low`/`nit` tail is handed back to you as
  a specific list rather than costing another review + fix agent pair. Pass
  `stopAt: 'nit'` to only stop on a fully clean PR.
- **`no-progress`** — a fix round neither fixed nor rejected anything. Usually
  the only threads left are a human's comments that a previous round already
  answered and deliberately won't re-argue.
- **`max-rounds-hit`** — 6 rounds elapsed.

Two details that matter more than they look:

**An untagged thread always counts as above the floor.** A teammate's plain
comment carries no severity tag, and it must never be the thing that ends the
loop just because nobody labelled it.

**Convergence is derived, not self-reported.** The subagent reports raw counts —
how many comments it posted, how many threads the script printed. Whether that
means "clean" is computed by the workflow. A reviewer that could declare its own
work finished would.

Because the floor makes severity load-bearing, a mislabelled finding has a real
cost: tag something `low` that's really `medium` and the loop hands it back
instead of fixing it. That's a deliberate trade — it buys you roughly a round
per run.

## The review

`pr-review` reads the changed file list, groups it into shards of at most 15
along real seams (schema, repository, logic, routes, components, tests), and
runs every angle over every shard in parallel — one agent per (angle × shard). A
100-file PR gets ~7 shards, not one agent skimming everything.

The angles:

1. **Correctness** — bugs, missing guards, stale state, checks dropped during a
   move or extraction, setup/teardown asymmetry in tests.
2. **Existing patterns** — find the closest existing feature of the same kind,
   name it as the reference, flag every divergence. No reinvention of a helper
   that already exists. *Precedent is not a defence*: if the PR copies a pattern
   that's itself wrong, flag both.
3. **Structure & layering** — query code in the repository, orchestration in
   logic, HTTP in the handler. One entity per dao/schema file.
4. **Frontend layout & shared primitives** — where components live, form
   controls through the project's own wrappers, no hardcoded in-app URLs.
5. **Names in full** — `documentKind`, not `dk`.
6. **Test value, not test count** — for every touched test, what breaks if you
   delete the assertion? "Tests added" is not coverage.
7. **Reuse, simplification, dead code** — derivable state, copy-paste with
   variation, a dependency added for what five lines already do.

Every candidate then goes to a **verifier agent** that returns CONFIRMED,
PLAUSIBLE or REFUTED against the repo as it actually stands. REFUTED gets
dropped. This is what stops the review inventing a violation of a convention the
repo doesn't have.

### Severity

Every comment opens with a tag: `blocker`, `high`, `medium`, `low`, `nit`.

Severity is **reachability × blast radius** — never how subtle the bug was or
how much the reviewer wants it fixed. A clever bug on a dead path is `low`.
Anything above `medium` has to name the input or sequence that reaches it in the
comment itself; a `blocker` with no concrete path is a `medium` oversold.

Severity orders the list. It never shortens it.

### Scope

Every finding is marked in-scope or out-of-scope. Out-of-scope means the problem
predates the PR and the PR didn't make it worse — it still gets posted, but it's
collected into one follow-up issue instead of being fixed here. "The rest of the
repo doesn't follow the new convention yet" is always out-of-scope; introducing
a convention doesn't oblige a PR to sweep the codebase.

## Things you'll probably want to change

**Angles 3 and 4 are written for a specific stack** — Next.js-style
`src/features/<feature>/components/`, one Drizzle `pgTable` per schema file, a
`components/form` wrapper layer, dao/repository/logic/route layering. That
specificity is the point: a review that says "follow good structure" finds
nothing. Rewrite those two sections for your own layout — that's the main edit
this repo expects you to make.

**`pr-loop.js` injects a `NO_ATTRIBUTION` instruction** telling every subagent
not to mention AI tooling in commits or PR replies. That's a personal
preference. Delete the constant and its two uses if you'd rather have
AI-authored commits labelled as such.

**`pr-address` never resolves threads, by design.** The fixer replies with a
commit SHA and leaves the thread open; only `pr-rereview` resolves, and only
after opening the file at that SHA and checking. An unverified "fixed"
disappearing from the unresolved list looks identical to a verified one.

**Report-only mode.** Both review commands take a `REPORT-ONLY` instruction —
they post nothing, open no issue, resolve nothing, and return the findings
instead. Useful for a dry run on someone else's PR.

## Cost

The loop is not cheap. One round is a review fan-out (angles × shards, plus a
verifier per candidate) followed by a fix agent. A large PR over several rounds
is a lot of tokens. Run `/pr-review` on its own first to see what you're in for
before reaching for `/pr-loop`.

## License

MIT

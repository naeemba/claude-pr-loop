---
description: Resolve a PR's conflicts with its base branch — merge the base in, resolve by hand, never rebase
argument-hint: <pr-number>
model: sonnet
effort: low
---

Check whether PR #$ARGUMENTS conflicts with its base branch, and if it does,
resolve the conflicts.

That is the whole job. No review, no refactoring, no drive-by fixes, however
tempting what you read on the way through the conflicted files.

## Start from a clean tree

If the repo already has an unfinished merge — `git status` says "You have
unmerged paths", or there are conflict markers in the working tree — an earlier
attempt died partway through. Do not start a second merge on top of it. Either
finish that one, or `git merge --abort` and begin again.

## Ask the forge first

    gh pr view $ARGUMENTS --json mergeable,baseRefName,headRefName

`"mergeable": "CONFLICTING"` means resolve. `"MERGEABLE"` means stop — report
that there was no conflict and do not touch the branch. Do not merge the base in
"to be safe": that puts a merge commit on a clean PR for nothing.

`"mergeable": "UNKNOWN"` means GitHub is still computing the answer. Wait about
ten seconds and ask again, up to three times. If it is still unknown after that,
stop and say so rather than guessing: report `hadConflicts` as null — not false.
False is a positive claim that the branch merges cleanly, and nobody checked.

## Merge the base in. Never rebase

Use the branch names you already have from step 1 — do not ask the forge twice.
Start from the PR's head as the forge has it, not from whatever the local
branch holds:

    git fetch origin <headRefName> <baseRefName> \
      && git switch --detach origin/<headRefName> \
      && git merge origin/<baseRefName>

A local `<headRefName>` can be behind the PR (the push is then rejected) or ahead
of it with unpushed commits (they would go out with the merge), and in a
worktree it is often checked out elsewhere, so `git checkout` fails. A detached
head at `origin/<headRefName>` sidesteps all three.

Rebasing force-pushes over a branch reviewers have commented on, and GitHub
drops every inline thread attached to the old commits. A run of `/pr-loop` can
leave twenty resolved threads documenting why each fix is what it is; rebase and
the reviewer opens the PR to find the conversation gone and the same questions
worth asking again. A merge commit is uglier and costs nothing.

## Resolve every file by hand

- **Keep both sides' intent.** The base branch's side is other people's work.
  This branch's side is what the PR is for. Drop either one and the diff looks
  fine — the code just quietly stops doing something it used to do.
- **Never take one whole side.** `--ours` and `--theirs` are banned unless the
  file is generated: a lockfile, a snapshot, a build artifact. For those,
  regenerate the file with the repo's own command instead of merging text — a
  hand-merged lockfile installs a dependency tree nobody has ever tested.
- **Stop rather than guess.** If two people changed the same logic in
  incompatible ways and the code does not tell you which one wins, run
  `git merge --abort`, leave the branch exactly as you found it, and report the
  conflict unresolved, naming the file and what the two sides disagree about.
  Say who to ask if the blame makes that obvious. A wrong resolution is worse
  than an open conflict: an open conflict blocks the merge button, and a wrong
  one lands looking deliberate.

## Run the repo's checks before pushing

Type-check, lint, tests — whatever the repo has. Two changes that each pass on
their own can fail together, and that is exactly what a conflict is. Do not push
a branch you know is red.

    git push origin HEAD:<headRefName>

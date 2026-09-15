---
description: Uncapped re-review after fix commits — verify each fix, resolve the thread, catch what the fixes broke
argument-hint: <pr-number>
---

On PR #$ARGUMENTS there are new commits fixing earlier findings. Re-review.

Read `~/.claude/review/standard.md` and apply it in full — the angles, the
no-cap rule, verification, scope, severity, report-only mode, the follow-up
issue and the board cards. "The change" there means this PR as a whole — its own
earlier commits included, not only the new fix commits. Do not restate it, do
not reinterpret it, and do not let this file's brevity make the re-review
shallower than a first review.

If that file cannot be read, stop and say the standard is missing. A review run
from this file alone has no angles in it and must not be reported as complete.

Three jobs, in this order:

1. **Verify each open thread.** Does the fix actually resolve what was asked —
   not "a commit touched that file", but the behaviour or structure the comment
   named.
2. **Review the new commits** for what they broke or introduced, using every
   angle in the standard.
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

## Coverage — shard the new commits

Diff the fix commits against the previously reviewed sha, not the whole PR.
Group the changed files into shards of at most 15 along real seams (schema,
repository, logic, routes, components, tests), then run every angle over every
shard as the standard describes.

A fix that moved a lot of code counts as new code. Review the destination, not
just the diff of the move.

## What a re-review adds to the angles

Every angle applies as written. These are the extra things a fix commit does:

- **Correctness.** A fix that moved or extracted code and dropped a check on the
  way.
- **Existing patterns.** A fix must not reinvent something that already exists —
  including something this very PR added a few commits ago.
- **Names in full.** Check the fix commits especially; a rushed fix is where
  short names get reintroduced.
- **Test value.** A fix that changed behaviour and left its tests untouched is a
  finding.
- **Reuse and dead code.** Code the fixes orphaned — a file, export, type or
  migration nothing references any more. Deleting what a refactor left behind is
  part of the fix.
- **Security.** A fix that moved a read or write to a new place and left the
  ownership check behind in the old one. An error path added by a fix that now
  returns a stack trace, a query, or PII.
- **Performance.** A fix that traded correctness for cost — a guard added inside
  a loop that now runs a query each pass is a new finding, not a resolved
  thread.

## Verify the fix claims too

The standard's verifier pass covers new candidates. Fix claims get the same
treatment: a reply saying "fixed in `<sha>`" is a claim, not evidence. Open the
file at that sha and check. A fix that changed the symptom and left the cause is
not fixed.

A structure candidate is verified against the repo as it now stands — is the
claim still true after the fix commits moved things.

If an earlier round asked for an eslint rule, check the config actually has it.

## Severity in a re-review

The table and the rules in the standard are unchanged. On top of them:

- **Confirmation replies carry no tag.** "Verified fixed in `<sha>`" is not a
  finding.
- **Severity is never a resolution gate:** a `nit` gets posted, a `blocker`
  whose fix works gets resolved.
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
how many findings were deduped into another comment, a link to the follow-up
issue holding the out-of-scope ones, and how many board cards you created.

In REPORT-ONLY mode the standard's rules apply, and additionally: resolve
nothing, and for each open thread report whether it is fixed, with the evidence.

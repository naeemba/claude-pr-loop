---
description: Address review comments on a PR — fix valid ones, reject invalid ones with explanation
argument-hint: <pr-number>
---

Check PR #$ARGUMENTS. There are review comments — go through each one:

- Decide if it's valid and relevant.
- If valid: fix it, then reply to the comment with the commit id of the fix.
- If rejecting: reply with a clear explanation of why.

## Never resolve threads

This command replies; it does not resolve. Do NOT call the
`resolveReviewThread` mutation on any thread — fixed or rejected, yours or
anyone else's. Resolution belongs to whoever verifies the fix: the re-review
pass (`/pr-rereview`) after it has independently confirmed the commit does what
the reply claims, or a human. Address resolving its own threads means the fixer
grades its own homework, and an unverified "fixed" disappears from the
unresolved list looking identical to a verified one.

- **Someone else's thread** doubly so: a different login means a human is
  waiting on an answer. Reply, leave it open, and say so in your summary.
- **Never reject the same thread twice.** If a thread already carries your
  rejection from an earlier round, leave it entirely alone — no second reply, no
  re-argument. Repeating yourself is what turns one disagreement into six rounds.
- A rejection needs a reason that stands on its own: why the described failure
  cannot happen, or why the suggested change is wrong here. "Out of scope" or
  "pre-existing" only counts if you say where it is handled instead. If you
  cannot write that sentence, it is not a rejection — fix it.

## Fetch ONLY unresolved threads

Run `~/.claude/scripts/pr-unresolved-threads.sh $ARGUMENTS` (inside the repo) —
it paginates GraphQL `reviewThreads` and prints only the unresolved threads
(thread id, comment ids, path, line, body, author). Do not paginate the REST
comments endpoint: it carries no resolution state, and resolved threads' bodies
are dead weight. Work every thread the script prints.

## Fix the pattern, not just the line

After fixing a comment, grep the PR's other changed files for the same pattern
and fix every occurrence in the same commit — a missing `catch`, a guard added
to one dialog but not its sibling, a helper deduplicated in one file and left
inline in another. Reviewers keep re-finding the same hole in sibling files
rounds later; one sweep now kills the whole class.

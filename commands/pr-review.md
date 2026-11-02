---
description: Uncapped PR review — bugs, security, performance, structure, frontend layout, naming, test value; one comment per root cause
argument-hint: <pr-number>
model: opus
effort: high
---

Review PR #$ARGUMENTS.

Read `~/.claude/review/standard.md` and apply it in full — the angles, the
no-cap rule, verification, scope, severity, report-only mode, the follow-up
issue and the board cards. "The change" there means this PR. Do not restate it,
do not reinterpret it, and do not let this file's brevity make the review
shallower.

If that file cannot be read, stop and say the standard is missing. A review run
from this file alone has no angles in it and must not be reported as complete.

This file adds three things: what to fetch, how to shard it, and how to post.

## Coverage — shard the diff

Read `gh api --paginate repos/{owner}/{repo}/pulls/$ARGUMENTS/files --jq '.[] |
"\(.filename) \(.additions + .deletions)"'` first — it gives the changed line
count per file, which the standard's shard size is measured in. Shard, group, route
and verify exactly as "Running the angles" and "Verify before posting" in the
standard say. A big PR gets several shards, not one agent skimming everything.

## Posting

Post each finding as an inline comment on the PR, with
`gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/comments` using `commit_id`,
`path`, `line` and `side: RIGHT` (or `mcp__github_inline_comment__create_inline_comment`
when that plugin is enabled). When the finding is about a file rather than
a line (layout, a file that should be split), post with `subject_type: file`.
Include a suggestion block only when it fully fixes the issue.

End with a count per tag, highest first, split in-scope / out-of-scope, plus
how many findings were deduped into another comment, a link to the follow-up
issue holding the out-of-scope ones, and how many board cards you created.

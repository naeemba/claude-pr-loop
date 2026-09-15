---
description: Uncapped PR review — bugs, security, performance, structure, frontend layout, naming, test value; one comment per root cause
argument-hint: <pr-number>
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

Read `gh pr diff $ARGUMENTS --name-only` first. Group the changed files into
shards of at most 15, split along real seams (schema, repository/dao, logic,
routes, components, tests). A 100-file PR gets ~7 shards, not one agent skimming
everything. Then run every angle over every shard as the standard describes.

## Posting

Post each finding as an inline comment on the PR. Prefer
`mcp__github_inline_comment__create_inline_comment`; if it is not available,
use `gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/comments` with `commit_id`,
`path`, `line` and `side: RIGHT`. When the finding is about a file rather than
a line (layout, a file that should be split), post with `subject_type: file`.
Include a suggestion block only when it fully fixes the issue.

End with a count per tag, highest first, split in-scope / out-of-scope, plus
how many findings were deduped into another comment, a link to the follow-up
issue holding the out-of-scope ones, and how many board cards you created.

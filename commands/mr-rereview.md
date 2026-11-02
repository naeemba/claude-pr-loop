---
description: Uncapped GitLab MR re-review after fix commits — verify each fix, resolve the thread, catch what the fixes broke
argument-hint: <mr-iid>
model: opus
effort: high
---

Re-review merge request !$ARGUMENTS on GitLab: there are new commits fixing
earlier findings.

Read `~/.claude/commands/pr-rereview.md` and the `~/.claude/review/standard.md`
it points at, and execute both in full against this MR, with `$ARGUMENTS` =
`$ARGUMENTS`. All three of its jobs stand — verify each open thread against the
code at the named sha, review the new commits for what they broke, then close
the loop — and so do the angles, the no-cap rule, scope, severity, the follow-up
issue and the board cards. Do not restate or soften any of it.

If either file cannot be read, stop and say which one is missing. A run from this
file alone has no angles in it and must not be reported as complete.

The ONE thing that changes is the forge. Which remote is the GitLab one, and the
host and project path that go with it, come from:

    eval "$(~/.claude/scripts/gitlab-remote.sh)"

It sets `GITLAB_REMOTE`, `GITLAB_HOST` and `GITLAB_PROJECT` from whichever remote
is the GitLab one — some repos keep GitHub on `origin` and GitLab on
a second remote called `gitlab` or `work`.

**Run the `eval` in the same Bash call as the command that needs it, every
time** — that is why every row below carries it as a prefix. A Bash tool call is
a fresh shell: the working directory carries over, exported variables do not.
Run the `eval` on its own and the next call sees an empty `$GITLAB_PROJECT`, so
`glab api "projects//merge_requests/12/diffs"` 404s, and an empty `$GITLAB_HOST`,
so `glab` falls back to the host it reads off `origin` — here, the GitHub mirror.

Then, wherever those two files reach for GitHub, use the right column.

| They say | Do this instead |
|---|---|
| `~/.claude/scripts/pr-unresolved-threads.sh N` | `~/.claude/scripts/mr-unresolved-threads.sh $ARGUMENTS` |
| `gh issue create` | `eval "$(~/.claude/scripts/gitlab-remote.sh)" && glab issue create -t "<title>" --description-file <file>` |
| `mcp__github_inline_comment__create_inline_comment` | not available on GitLab — use the row below |
| `gh api repos/{owner}/{repo}/pulls/N/comments` | `eval "$(~/.claude/scripts/gitlab-remote.sh)" && glab mr note create $ARGUMENTS --file <path> --line <line> -m "<body>"` |
| reply on an existing thread | `eval "$(~/.claude/scripts/gitlab-remote.sh)" && glab mr note create $ARGUMENTS --reply <discussion-id> -m "<body>"` |
| `resolveReviewThread` with the thread id | `eval "$(~/.claude/scripts/gitlab-remote.sh)" && glab mr note resolve $ARGUMENTS <discussion-id>` |
| `"${PR_LOOP_CARD_SCRIPT/#\~/$HOME}" …` | `eval "$(~/.claude/scripts/gitlab-remote.sh)" && "${PR_LOOP_CARD_SCRIPT/#\~/$HOME}" --remote "$GITLAB_REMOTE" …` |

That `--remote` matters: without it a card script that pushes to a remote picks
`origin`, which here is the GitHub mirror, and the follow-up work lands on a
board nobody reads.

`--paginate` and `per_page=100` are not decoration: `/diffs` hands back 20 files
a page by default, and nothing warns you about the rest. An MR touching 60 files
would list 20, verify fixes against those, and never open the other 40 — where
the commits being re-reviewed may well be.

The discussion id for both `--reply` and `resolve` is the `id` field
`mr-unresolved-threads.sh` prints. Reply first, then resolve — a thread that
vanishes from the list with no explanation of what was checked is worse than one
left open.

## Outdated threads still count

When a fix moved or deleted the file, the script prints the thread with `path`
and `line` from the note's old position, or `null` for both, and GitLab marks it
outdated in the UI. That is what a good fix looks like, not a thread to skip:
follow the code to where it went and verify it there.

## MR iid, not MR id

`$ARGUMENTS` is the merge request's **iid** — the `!123` a human sees, scoped to
this project. Every API path above takes the iid. GitLab also puts a global `id`
on the same object; pass that instead and you silently address a different MR in
a different project.

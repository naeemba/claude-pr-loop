---
description: Uncapped GitLab MR review — bugs, security, performance, structure, frontend layout, naming, test value; one comment per root cause
argument-hint: <mr-iid>
model: opus
effort: high
---

Review merge request !$ARGUMENTS on GitLab.

Read `~/.claude/commands/pr-review.md` and the `~/.claude/review/standard.md`
it points at, and execute both in full against this MR, with `$ARGUMENTS` =
`$ARGUMENTS`. Everything they say about what to look for — the angles, the
no-cap rule, verification, scope, severity, the follow-up issue and the board
cards — applies here word for word. Do not restate it, do not reinterpret it,
and do not let this file's brevity make the review shallower.

If either file cannot be read, stop and say which one is missing. A run from this
file alone has no angles in it and must not be reported as complete.

The ONE thing that changes is the forge. GitHub calls it a pull request and
talks to it with `gh`; GitLab calls it a merge request and talks to it with
`glab`. Which remote is the GitLab one, and the host and project path that go
with it, come from:

    eval "$(~/.claude/scripts/gitlab-remote.sh)"

It sets `GITLAB_REMOTE`, `GITLAB_HOST` and `GITLAB_PROJECT` from whichever
remote is the GitLab one — some repos keep GitHub on `origin` and
GitLab on a second remote called `gitlab` or `work`. If the script says there is
no non-GitHub remote, stop: `/pr-review` is the command that was wanted.

**Run the `eval` in the same Bash call as the command that needs it, every
time** — that is why every row below carries it as a prefix. A Bash tool call is
a fresh shell: the working directory carries over, exported variables do not.
Run the `eval` on its own and the next call sees an empty `$GITLAB_PROJECT`, so
`glab api "projects//merge_requests/12/diffs"` 404s, and an empty `$GITLAB_HOST`,
so `glab` falls back to the host it reads off `origin` — here, the GitHub mirror.

Then, wherever those two files reach for GitHub, use the right column.

| They say | Do this instead |
|---|---|
| `gh api --paginate repos/{owner}/{repo}/pulls/N/files …` | `eval "$(~/.claude/scripts/gitlab-remote.sh)" && glab api --paginate "projects/$GITLAB_PROJECT/merge_requests/$ARGUMENTS/diffs?per_page=100" \| jq -r '.[] \| "\(.new_path) \([.diff \| split("\n")[] \| select(test("^[+-]"))] \| length)"'` |
| `gh issue create` | `eval "$(~/.claude/scripts/gitlab-remote.sh)" && glab issue create -t "<title>" --description-file <file>` |
| `mcp__github_inline_comment__create_inline_comment` | not available on GitLab — use the row below |
| `gh api repos/{owner}/{repo}/pulls/N/comments` | `eval "$(~/.claude/scripts/gitlab-remote.sh)" && glab mr note create $ARGUMENTS --file <path> --line <line> -m "<body>"` |
| a file-level comment (`subject_type: file`) | the same command with `--file <path>` and no `--line` |
| `"$PR_LOOP_CARD_SCRIPT" …` | `eval "$(~/.claude/scripts/gitlab-remote.sh)" && "$PR_LOOP_CARD_SCRIPT" --remote "$GITLAB_REMOTE" …` |

That `--remote` matters: without it a card script that pushes to a remote picks
`origin`, which here is the GitHub mirror, and the follow-up work lands on a
board nobody reads.

`--paginate` and `per_page=100` are not decoration: `/diffs` hands back 20 files
a page by default, and nothing warns you about the rest. An MR touching 60 files
would list 20, shard those, review them, post findings — and the other 40 would
never be opened, with the review reading as complete.

The `/diffs` call already returns each file's patch in its `diff` field. Use
that for the diff itself rather than fetching the whole MR again — which is also
why the truncation above has to be fixed here and not caught later: the missing
files take their patches with them.

A file whose `diff` comes back empty is not a zero-line change. GitLab drops the
patch of any file over its size limit and shows it as "Too large"
(https://docs.gitlab.com/administration/diff_limits/). A 4,000-line migration
would be counted as 0 lines and packed into a shard as if it cost nothing. Count
every empty-`diff` file from git instead, pack it by that count like any other
file, and read its patch from git too. A pure rename or mode change also comes
back empty, and git counts it as 0, so it joins a normal shard; a real
4,000-line file is over the shard target and ends up alone anyway.

Fetch the MR head through `refs/merge-requests/<iid>/head`, which GitLab
publishes on the target project for every MR, forks included. Fetch it first so
`FETCH_HEAD` points at it:

    eval "$(~/.claude/scripts/gitlab-remote.sh)" && git fetch "$GITLAB_REMOTE" "refs/merge-requests/$ARGUMENTS/head" <target-branch> && git diff --numstat "$GITLAB_REMOTE/<target-branch>...FETCH_HEAD" -- <path>

Swap `--numstat` for nothing to get the patch itself.

## MR iid, not MR id

`$ARGUMENTS` is the merge request's **iid** — the `!123` a human sees, scoped to
this project. Every API path above takes the iid. GitLab also puts a global `id`
on the same object; pass that instead and you silently address a different MR in
a different project.

## Threads, not review threads

`glab` posts each comment as its own discussion thread, so "one comment per root
cause" lands the same way it does on GitHub. There is no batched "review" object
to submit — comments go live the moment you post them. Post in severity order,
highest first, so the author reads the blockers before the nits.

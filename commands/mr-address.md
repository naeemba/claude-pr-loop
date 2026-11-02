---
description: Address review comments on a GitLab MR — fix valid ones, reject invalid ones with explanation
argument-hint: <mr-iid>
model: sonnet
effort: low
---

Address the review comments on merge request !$ARGUMENTS on GitLab.

Read `~/.claude/commands/pr-address.md` and execute it in full against this MR,
with `$ARGUMENTS` = `$ARGUMENTS`. Everything it says still holds: never reject the
same thread twice, a rejection needs a reason that stands on its own, and after
every fix sweep the sibling files for the same pattern and fix them in the same
commit.

The ONE thing that changes is the forge. Which remote is the GitLab one, and the
host and project path that go with it, come from:

    eval "$(~/.claude/scripts/gitlab-remote.sh)"

It sets `GITLAB_REMOTE`, `GITLAB_HOST` and `GITLAB_PROJECT` from whichever remote
is the GitLab one — some repos keep GitHub on `origin` and GitLab on
a second remote called `gitlab` or `work`.

**Run the `eval` in the same Bash call as the `glab` command or the push that
needs it, every time** — that is why it is written as a prefix below. A Bash tool
call is a fresh shell: the working directory carries over, exported variables do
not. Run the `eval` on its own and the next call sees `$GITLAB_REMOTE` empty, so
`git push "" HEAD` dies with `'' does not appear to be a git repository`, and
`$GITLAB_HOST` empty, so `glab` talks to whatever host `origin` names — here, the
GitHub mirror.

| `pr-address.md` says | Do this instead |
|---|---|
| `~/.claude/scripts/pr-unresolved-threads.sh N` | `~/.claude/scripts/mr-unresolved-threads.sh $ARGUMENTS` |
| reply to a comment | `eval "$(~/.claude/scripts/gitlab-remote.sh)" && glab mr note create $ARGUMENTS --reply <discussion-id> -m "<body>"` |
| the `resolveReviewThread` mutation (banned) | `glab mr note resolve` and `--resolve` — equally banned, see below |

The script prints one object per open thread: `id` (the discussion id, which is
what `--reply` and any later resolve take), `path`, `line`, and its `notes` with
each note's id, body and author. Work every thread it prints.

## Still never resolve

`glab mr note resolve` is this forge's version of the mutation `pr-address.md`
forbids, and the ban is the same: the fixer does not grade its own homework.
Reply with the commit sha and leave the thread open. `/mr-rereview` resolves it
once it has opened the file at that sha and checked.

## Push to the GitLab remote

    eval "$(~/.claude/scripts/gitlab-remote.sh)" && git push "$GITLAB_REMOTE" "HEAD:$(glab api \
      "projects/$GITLAB_PROJECT/merge_requests/$ARGUMENTS" | jq -r .source_branch)"

Name the destination branch: a conflicts round can leave the checkout detached,
and `git push "$GITLAB_REMOTE" HEAD` then fails with `Did you mean to create a
new branch by pushing to 'HEAD:refs/heads/HEAD'?`.

`git push` with no argument follows the branch's configured upstream, which in
some repos may well be GitHub. Push there and the MR never sees the fix, every
reply points at a sha the reviewer cannot find, and the next re-review round
re-finds everything.

---
description: Resolve a GitLab MR's conflicts with its target branch — merge the target in, resolve by hand, never rebase
argument-hint: <mr-iid>
model: sonnet
effort: low
---

Resolve the conflicts on merge request !$ARGUMENTS on GitLab.

Read `~/.claude/commands/pr-conflicts.md` and execute it in full against this MR,
with `$ARGUMENTS` = `$ARGUMENTS`. Everything it says still holds: merge, never
rebase; keep both sides; `--ours`/`--theirs` only for generated files; abort
rather than guess; run the repo's checks before pushing.

The ONE thing that changes is the forge. Which remote is the GitLab one, and the
host and project path that go with it, come from:

    eval "$(~/.claude/scripts/gitlab-remote.sh)"

It sets `GITLAB_REMOTE`, `GITLAB_HOST` and `GITLAB_PROJECT` from whichever remote
is the GitLab one — some repos keep GitHub on `origin` and GitLab on
a second remote called `gitlab` or `work`.

**Run the `eval` in the same Bash call as the command that needs it, every
time** — that is why it is written as a prefix below. A Bash tool call is a fresh
shell: the working directory carries over, exported variables do not. Run the
`eval` on its own and the next call sees `$GITLAB_REMOTE` empty, so
`git push "" HEAD` dies, and `$GITLAB_PROJECT` empty, so the API path becomes
`projects//merge_requests/...` and 404s.

| `pr-conflicts.md` says | Do this instead |
|---|---|
| `gh pr view N --json mergeable,...` | the `glab api` call below |
| `"mergeable": "CONFLICTING"` | `"has_conflicts": true` or `"detailed_merge_status": "conflict"` |
| `"mergeable": "UNKNOWN"` (still computing) | `"detailed_merge_status"` is `checking`, `unchecked` or `preparing` — `has_conflicts` reads `false` in all three, so it proves nothing until the check finishes |
| `git fetch origin <head> <base>` / `git switch --detach origin/<head>` / `git merge origin/<base>` | the fetch, switch and merge below |
| `git push origin HEAD:<head>` | the push below |

## Ask the forge

    eval "$(~/.claude/scripts/gitlab-remote.sh)" && glab api \
      "projects/$GITLAB_PROJECT/merge_requests/$ARGUMENTS" \
      | jq '{has_conflicts, detailed_merge_status, target_branch, source_branch}'

## Start from the MR's source branch, then merge the target in

    eval "$(~/.claude/scripts/gitlab-remote.sh)" \
      && git fetch "$GITLAB_REMOTE" <source_branch> <target_branch> \
      && git switch --detach "$GITLAB_REMOTE/<source_branch>" \
      && git merge "$GITLAB_REMOTE/<target_branch>"

## Push to the GitLab remote

    eval "$(~/.claude/scripts/gitlab-remote.sh)" && git push "$GITLAB_REMOTE" HEAD:<source_branch>

`git push` with no argument follows the branch's configured upstream, which in
some repos may well be GitHub. Push the merge there and the MR stays
conflicted, the merge button stays greyed out, and the next person to look
cannot see why — the conflict was resolved, just not anywhere GitLab can see.

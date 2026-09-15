---
description: Run the full GitLab MR review -> fix -> re-review chain with fresh-context subagents (up to 6 rounds). Subagents push commits autonomously.
argument-hint: <mr-iid>
---

Run the review/fix/re-review loop for merge request !$ARGUMENTS on GitLab.

Call the `Workflow` tool with:
- `scriptPath`: the ABSOLUTE path to `pr-loop.js` — your home directory followed
  by `/.claude/workflows/pr-loop.js`. The Workflow tool does not expand `~`.
- `args`: `{ "pr": "$ARGUMENTS", "forge": "gitlab" }` — plus any of `stopAt`,
  `maxRounds`, `startAt` and `worktree`, which mean exactly what they mean for
  `/pr-loop`; see that file for each. **`forge` is not optional here**: leave it
  out and every round runs the GitHub commands and `gh` against a project that
  has no pull requests.

This is explicit user opt-in for multi-agent orchestration — they invoked this slash command.

It is the same workflow `/pr-loop` runs; `forge: "gitlab"` only swaps which
command file each round executes — `/mr-review`, `/mr-rereview`, `/mr-address`
instead of their `pr-` twins — and which script lists the open threads. Rounds,
counts, the severity floor and every stopping rule are identical.

Read `~/.claude/commands/pr-loop.md` for the rest: the review dimensions, the
severity floor and what each final status means. All of it applies unchanged.
Two words differ — pull request is merge request, and the number is the MR's
project-scoped **iid**, the `!123` a human sees.

## Before starting

`glab` must be installed and authenticated against the GitLab host, and that
host must be reachable — some of these live on a LAN and need the VPN up. Check
once, here, rather than letting six subagents each rediscover it:

    eval "$(~/.claude/scripts/gitlab-remote.sh)" && glab auth status --hostname "$GITLAB_HOST"

`--hostname` is what makes this a check. Bare `glab auth status` reports on every
host `glab` knows, so being logged in to `gitlab.com` — nearly everyone is —
prints green while `git.example.lan` sits behind a VPN that is down, which is the one
case this paragraph exists to catch. It also catches never having authenticated
against the self-hosted host at all. The `eval` has to be in the same call: a
Bash tool call is a fresh shell, and `glab` reads the host out of `GITLAB_HOST`.

If it fails, stop and say so. A loop whose every round cannot reach the forge
burns twelve agents to report the same connection error.

> NOTE: the per-round subagent prompts live in `~/.claude/workflows/pr-loop.js`
> and execute the `/mr-review`, `/mr-rereview` and `/mr-address` command bodies
> verbatim, which in turn execute their `pr-` twins with the forge translated.
> Keep the script and these command files in sync when either changes.

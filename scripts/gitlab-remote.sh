#!/usr/bin/env bash
# Work out which remote is the GitLab one, and print what every GitLab command
# needs from it. One place, because several repos keep GitHub on `origin` and
# GitLab on a second remote (`gitlab`, `work`) -- guess wrong and a review posts
# nothing, or a fix pushes to a mirror the merge request cannot see.
#
#   eval "$(gitlab-remote.sh)"   # sets GITLAB_REMOTE, GITLAB_HOST, GITLAB_PROJECT
#
# GITLAB_PROJECT is URL-encoded and drops straight into an API path:
#   glab api "projects/$GITLAB_PROJECT/merge_requests/123/discussions"
#
# Set GITLAB_REMOTE yourself to override the search.
set -euo pipefail

# Callers write `eval "$(gitlab-remote.sh)" && glab ...`. On failure this script
# prints nothing, and an eval of nothing succeeds -- so the glab command would
# run anyway, with empty variables, against the GitHub mirror. Print `false` as
# well and the `&&` stops there. The real explanation is already on stderr.
trap '[ $? = 0 ] || echo false' EXIT

remote=${GITLAB_REMOTE:-}
if [ -z "$remote" ]; then
  # Positive match first. "Not GitHub" also matches a NAS mirror, a Gitea box or
  # a heroku remote, and `git remote` lists alphabetically -- a `backup` remote
  # would win over a `gitlab` one. Only fall back to the first non-GitHub remote
  # when no URL says gitlab at all.
  fallback=
  for candidate in $(git remote); do
    case "$(git remote get-url "$candidate")" in
      *github.com*) continue ;;
      *gitlab*) remote=$candidate; break ;;
    esac
    [ -n "$fallback" ] || fallback=$candidate
  done
  remote=${remote:-$fallback}
fi
[ -n "$remote" ] || { echo "gitlab-remote.sh: no non-GitHub remote here; set GITLAB_REMOTE" >&2; exit 1; }

# git@host:group/sub/project.git, https://host/group/sub/project.git, ssh://git@host:2222/group/project.git
url=$(git remote get-url "$remote")
host=$(sed -E 's#^(git@|ssh://git@|https?://)([^/:]+)[/:].*#\2#' <<<"$url")
project=$(sed -E 's#^(git@|ssh://git@|https?://)[^/:]+(:[0-9]+)?[/:]##; s#\.git$##' <<<"$url")

printf 'export GITLAB_REMOTE=%q GITLAB_HOST=%q GITLAB_PROJECT=%q\n' \
  "$remote" "$host" "$(jq -rn --arg p "$project" '$p|@uri')"

#!/usr/bin/env bash
# Print a GitLab merge request's UNRESOLVED discussion threads as JSON, or just
# their count with --count. The GitHub twin of this script is
# pr-unresolved-threads.sh; both exist so the review commands never have to
# paginate a forge API themselves.
#
# A thread is included when it is resolvable and not yet resolved. Plain MR
# comments and system notes are not resolvable and never appear — same as the
# GitHub script, which only ever returned review threads.
#
# Output shape (one object per open thread):
#   [{ "id": "<discussion id>",        # what `glab mr note resolve` takes
#      "path": "src/x.ts", "line": 42, # null on an outdated thread
#      "notes": [{ "id": 123, "body": "...", "author": "alice" }] }]
#
# Usage: mr-unresolved-threads.sh <mr-iid> [--count]   (run inside the repo)
#
# gitlab-remote.sh beside this file works out which remote is the GitLab one --
# in some repos `origin`, in others `gitlab` or `work`, with GitHub sitting on
# `origin` beside it. Set GITLAB_REMOTE to override its search.
set -euo pipefail

iid=${1:?usage: mr-unresolved-threads.sh <mr-iid> [--count]}
mode=${2:-}

# Which remote, which host, which project -- resolved in one place, because
# several repos keep GitHub on `origin` and GitLab on a second remote.
# Captured first: `eval "$(cmd)"` reports eval's status, not the command's, so a
# failed lookup would print its own error and then die again on an unbound
# GITLAB_PROJECT. This way set -e fires on the real failure, once.
settings=$("$(dirname "$0")/gitlab-remote.sh")
eval "$settings"

threads='[]'
page=1
while :; do
  batch=$(glab api \
    "projects/$GITLAB_PROJECT/merge_requests/$iid/discussions?per_page=100&page=$page")
  count=$(jq 'length' <<<"$batch")
  # Through stdin, not --argjson: one page of a busy MR outgrows the 128 KiB
  # limit Linux puts on a single argument ("Argument list too long").
  threads=$(printf '%s\n%s' "$threads" "$batch" | jq -s '.[0] + .[1]')
  [ "$count" -eq 100 ] || break
  page=$((page + 1))
done

# The first note is not always the one carrying the diff position (a system
# note can sit in front of it), so the path and line come from the first note
# that has a position at all. Both are null on a thread whose file the fix
# already moved or deleted -- that is a good fix, not a thread to skip.
open=$(jq '[ .[]
  | select(any(.notes[]; .resolvable == true and .resolved != true))
  | ([ .notes[] | select(.position != null) ][0].position) as $position
  | { id: .id,
      path:  ($position.new_path // $position.old_path),
      line:  ($position.new_line // $position.old_line),
      notes: [ .notes[] | select(.system != true)
             | { id: .id, body: .body, author: .author.username } ] } ]' <<<"$threads")

if [ "$mode" = "--count" ]; then
  jq 'length' <<<"$open"
else
  jq . <<<"$open"
fi

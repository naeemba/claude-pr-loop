#!/usr/bin/env bash
# Print a PR's UNRESOLVED review threads as JSON (thread id + comments with
# databaseId/path/line/body/author), or just their count with --count.
# Resolution state only exists in GraphQL reviewThreads — REST comments have
# none — and resolved threads are filtered out here so they never reach the
# caller's context. Paginates the full connection.
# Usage: pr-unresolved-threads.sh <pr-number> [--count]   (run inside the repo)
set -euo pipefail

pr=${1:?usage: pr-unresolved-threads.sh <pr-number> [--count]}
mode=${2:-}

owner=$(gh repo view --json owner --jq .owner.login)
name=$(gh repo view --json name --jq .name)

query='query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$name){pullRequest(number:$pr){
    reviewThreads(first:100,after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{id isResolved comments(first:100){nodes{databaseId path line body author{login}}}}
    }}}}'

threads='[]'
cursor=''
while :; do
  args=(-F owner="$owner" -F name="$name" -F pr="$pr")
  [ -n "$cursor" ] && args+=(-F cursor="$cursor")
  page=$(gh api graphql "${args[@]}" -f query="$query")
  # Through stdin, not --argjson: a page outgrows the 128 KiB argument limit.
  threads=$(printf '%s\n%s' "$threads" "$page" | jq -s \
    '.[0] + (.[1].data.repository.pullRequest.reviewThreads.nodes | map(select(.isResolved | not)))')
  hasNext=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$page")
  [ "$hasNext" = "true" ] || break
  cursor=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor' <<<"$page")
done

if [ "$mode" = "--count" ]; then
  jq 'length' <<<"$threads"
else
  jq . <<<"$threads"
fi

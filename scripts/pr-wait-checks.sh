#!/usr/bin/env bash
# Wait for CI on a PR's head commit and print the outcome as the last line.
# Run it as a background Bash call; never sleep before it.
#
#   ~/.claude/scripts/pr-wait-checks.sh <pr-number>
#
# Under Dashboard (DASHBOARD_COMMAND set) this is `pr wait`, which waits on the
# head commit's checks, rides out network blips, and ends with
# `checks passed on <sha>`, a failure, or `conflicts with main: <files> — …`.
# Dashboard before v2.55 has no `pr wait` and answers `unknown` (2.54 says
# `no such command: wait`); then, and without Dashboard, watch the head
# commit's own runs with gh.
set -uo pipefail
pr=${1:?usage: pr-wait-checks.sh <pr-number>}

if [ -n "${DASHBOARD_COMMAND:-}" ]; then
  output=$(node "$DASHBOARD_COMMAND" pr wait "$pr" 2>&1)
  status=$?
  if ! grep -qiE '^(unknown|no such command)' <<<"$output"; then
    printf '%s\n' "$output"
    exit "$status"
  fi
fi

read -r sha mergeable base < <(gh pr view "$pr" --json headRefOid,mergeable,baseRefName \
  -q '"\(.headRefOid) \(.mergeable) \(.baseRefName)"') || exit 1
# A conflicting PR gets no pull_request run, so say so instead of waiting.
if [ "$mergeable" = CONFLICTING ]; then
  echo "conflicts with $base — merge it in before CI can run"
  exit 1
fi
# gh prints nothing, not 0, for a repo with no workflows.
workflows=$(gh workflow list --json id -q length) || exit 1
if [ "${workflows:-0}" = 0 ]; then
  echo "no CI run for $sha: the repo has no workflows"
  exit 0
fi
# A run shows up a few seconds after the push. Poll for it rather than sleeping
# up front, and give up after two minutes: a draft or path-filtered push may
# never get one.
# ponytail: fixed 2-minute window, raise it for a forge that queues slowly.
for _ in $(seq 24); do
  runs=$(gh run list --commit "$sha" --json databaseId -q '.[].databaseId') || exit 1
  [ -n "$runs" ] && break
  sleep 5
done
if [ -z "$runs" ]; then
  echo "no CI run for $sha"
  exit 0
fi
for run in $runs; do
  if ! gh run watch "$run" --interval 30 --exit-status >/dev/null; then
    echo "checks failed on $sha: run $run"
    exit 1
  fi
done
echo "checks passed on $sha"

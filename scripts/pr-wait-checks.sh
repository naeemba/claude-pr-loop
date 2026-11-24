#!/usr/bin/env bash
# Wait for CI on a PR's head commit and print the outcome as the last line.
# Run it as a background Bash call; never sleep before it.
#
#   ~/.claude/scripts/pr-wait-checks.sh <pr-number> [pushed-sha]
#
# Pass the sha just pushed so a stale PR head is waited out, not reported.
#
# Under Dashboard (DASHBOARD_COMMAND set) this is `pr wait`, which waits on the
# head commit's checks, rides out network blips, and ends with
# `checks passed on <sha>`, a failure, or `conflicts with main: <files> — …`.
# Dashboard before v2.55 has no `pr wait` and answers `unknown` (2.54 says
# `no such command: wait`); then, and without Dashboard, watch the head
# commit's own runs with gh.
set -uo pipefail
pr=${1:?usage: pr-wait-checks.sh <pr-number> [pushed-sha]}
want=${2:-}

if [ -n "${DASHBOARD_COMMAND:-}" ]; then
  output=$(node "$DASHBOARD_COMMAND" pr wait "$pr" 2>&1)
  status=$?
  if ! grep -qiE '^(unknown|no such command)' <<<"$output"; then
    printf '%s\n' "$output"
    exit "$status"
  fi
fi

# Only runs created from here on count: a draft push's run (every job skipped)
# finished before the PR went ready, and must not pass for the real one. Back
# off a minute for a run created right after the push that started this wait.
ago=$(($(date +%s) - 60))
started=$(date -u -d "@$ago" +%FT%TZ 2>/dev/null || date -u -r "$ago" +%FT%TZ)
# Overridable so the self-check runs in seconds.
tries=${PR_WAIT_TRIES:-24} interval=${PR_WAIT_INTERVAL:-5}

# Wait for the PR to show the pushed sha (GitHub moves headRefOid a moment after
# the push) and for mergeable to settle (it reads UNKNOWN while recomputed).
for ((try = 1; ; try++)); do
  read -r sha mergeable base < <(gh pr view "$pr" --json headRefOid,mergeable,baseRefName \
    -q '"\(.headRefOid) \(.mergeable) \(.baseRefName)"') || exit 1
  [ "$sha" = "${want:-$sha}" ] && [ "$mergeable" != UNKNOWN ] && break
  if [ "$try" -ge "$tries" ]; then
    [ "$sha" = "${want:-$sha}" ] || { echo "PR $pr never showed $want (head is $sha)"; exit 1; }
    break
  fi
  sleep "$interval"
done
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
# Runs show up a few seconds after the push, and workflows on different events
# a few seconds apart. Watch each new run, and stop once a few re-lists in a
# row find nothing unwatched; give up after `tries` empty lists with no run at
# all, since a path-filtered push may never get one.
# ponytail: fixed windows (2 min for a first run, 15 s quiet after), raise them
# for a forge that queues slowly.
watched=" " idle=0
while :; do
  runs=$(gh run list --commit "$sha" --json databaseId,createdAt \
    -q ".[] | select(.createdAt >= \"$started\") | .databaseId") || exit 1
  new=0
  for run in $runs; do
    [[ $watched == *" $run "* ]] && continue
    new=1 watched+="$run "
    if ! gh run watch "$run" --interval 30 --exit-status >/dev/null; then
      echo "checks failed on $sha: run $run"
      exit 1
    fi
  done
  if [ "$new" = 0 ]; then
    idle=$((idle + 1))
    if [ "$watched" = " " ]; then
      [ "$idle" -ge "$tries" ] && { echo "no CI run for $sha"; exit 0; }
    else
      [ "$idle" -ge 3 ] && break
    fi
    sleep "$interval"
  fi
done
echo "checks passed on $sha"

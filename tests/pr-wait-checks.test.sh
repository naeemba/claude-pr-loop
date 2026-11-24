#!/usr/bin/env bash
# Self-check for pr-wait-checks.sh. Stubs `node` (Dashboard) and `gh`, so it
# runs with no network and no Dashboard.
#   tests/pr-wait-checks.test.sh
set -euo pipefail
cd "$(dirname "$0")"
script=$PWD/../scripts/pr-wait-checks.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# Dashboard stub: prints $DASHBOARD_REPLY and exits $DASHBOARD_EXIT.
cat > "$work/bin/node" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$DASHBOARD_REPLY"
exit "${DASHBOARD_EXIT:-0}"
STUB
# gh stub: head sha abc123 (old999 for the first $GH_STALE views), mergeable
# $GH_MERGEABLE (UNKNOWN for the first $GH_UNSETTLED views), runs from $GH_RUNS
# once $GH_EMPTY lists have come back empty, plus $GH_LATE from the list after
# that; a run fails if named in $GH_FAIL.
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$WORK/gh-calls"
count() { grep -c "^$1" "$WORK/gh-calls"; }
case "$1 $2" in
  "pr view")
    n=$(count 'pr view')
    sha=abc123 mergeable=${GH_MERGEABLE:-MERGEABLE}
    [ "$n" -le "${GH_STALE:-0}" ] && sha=old999
    [ "$n" -le "${GH_UNSETTLED:-0}" ] && mergeable=UNKNOWN
    echo "$sha $mergeable main" ;;
  "workflow list") printf "%s" "${GH_WORKFLOWS-2}" ;;
  "run list")
    n=$(count 'run list') empty=${GH_EMPTY:-0}
    [ "$n" -le "$empty" ] && exit 0
    printf '%s\n' $GH_RUNS
    [ "$n" -gt $((empty + 1)) ] && printf '%s\n' ${GH_LATE:-}
    true ;;
  "run watch") [ "$3" != "${GH_FAIL:-}" ] ;;
esac
STUB
chmod +x "$work/bin/node" "$work/bin/gh"
export PATH="$work/bin:$PATH" WORK=$work GH_RUNS="11 12" PR_WAIT_INTERVAL=0

fail() { echo "FAIL: $*"; exit 1; }
run() { rm -f "$work/gh-calls"; "$script" 7 "$@" 2>&1 | tail -1; }
calls() { grep -c "^$1" "$work/gh-calls"; }

# Dashboard with pr wait: its last line is the answer, gh is never touched.
out=$(DASHBOARD_COMMAND=/x DASHBOARD_REPLY=$'waiting\nchecks passed on abc123' run)
[ "$out" = "checks passed on abc123" ] || fail "dashboard pass: $out"
[ ! -e "$work/gh-calls" ] || fail "gh called under dashboard"
out=$(DASHBOARD_COMMAND=/x DASHBOARD_REPLY='conflicts with main: a.ts — merge main' DASHBOARD_EXIT=1 run) || true
[ "$out" = "conflicts with main: a.ts — merge main" ] || fail "dashboard conflict: $out"

# Dashboard without pr wait (unknown, or 2.54's "no such command") falls back to gh.
for reply in 'unknown command: pr wait' 'no such command: wait'; do
  out=$(DASHBOARD_COMMAND=/x DASHBOARD_REPLY=$reply run)
  [ "$out" = "checks passed on abc123" ] || fail "fallback on '$reply': $out"
  grep -q -- '--commit abc123' "$work/gh-calls" || fail "did not list the head sha's runs"
done

# No Dashboard: gh watches every run of the head sha, and reports the failing one.
out=$(DASHBOARD_COMMAND= run)
[ "$out" = "checks passed on abc123" ] || fail "gh pass: $out"
[ "$(grep -c 'run watch' "$work/gh-calls")" = 2 ] || fail "did not watch both runs"
if out=$(DASHBOARD_COMMAND= GH_FAIL=12 run); then fail "failed run exited 0"; fi
[ "$out" = "checks failed on abc123: run 12" ] || fail "gh failure: $out"

# Conflicts and a repo with no workflows answer at once, without listing runs.
out=$(DASHBOARD_COMMAND= GH_MERGEABLE=CONFLICTING run) || true
[ "$out" = "conflicts with main — merge it in before CI can run" ] || fail "gh conflict: $out"
out=$(DASHBOARD_COMMAND= GH_WORKFLOWS= run)
[ "$out" = "no CI run for abc123: the repo has no workflows" ] || fail "no workflows: $out"
! grep -q 'run list' "$work/gh-calls" || fail "listed runs with no workflows"

# No run yet: list again until one shows up; none in time is "no CI run".
out=$(DASHBOARD_COMMAND= GH_EMPTY=2 run)
[ "$out" = "checks passed on abc123" ] || fail "poll: $out"
[ "$(calls 'run watch')" = 2 ] || fail "poll did not watch both runs"
out=$(DASHBOARD_COMMAND= GH_EMPTY=99 PR_WAIT_TRIES=3 run)
[ "$out" = "no CI run for abc123" ] || fail "timeout: $out"
[ "$(calls 'run list')" = 3 ] || fail "timeout listed $(calls 'run list') times, not 3"

# A run that starts after the first ones finish is watched too, and its
# failure is reported.
if out=$(DASHBOARD_COMMAND= GH_LATE=13 GH_FAIL=13 run); then fail "late failed run exited 0"; fi
[ "$out" = "checks failed on abc123: run 13" ] || fail "late run: $out"
# Only runs created within the wait are listed.
grep -q 'select(.createdAt >= ' "$work/gh-calls" || fail "runs not filtered by createdAt"

# A stale head is waited out when the pushed sha is passed, and reported if it
# never moves; an UNKNOWN mergeable is read again before deciding.
out=$(DASHBOARD_COMMAND= GH_STALE=2 run abc123)
[ "$out" = "checks passed on abc123" ] || fail "stale head: $out"
! grep -q 'old999' "$work/gh-calls" || fail "listed the stale sha's runs"
out=$(DASHBOARD_COMMAND= GH_STALE=99 PR_WAIT_TRIES=2 run abc123) || true
[ "$out" = "PR 7 never showed abc123 (head is old999)" ] || fail "head never moved: $out"
out=$(DASHBOARD_COMMAND= GH_UNSETTLED=2 GH_MERGEABLE=CONFLICTING run) || true
[ "$out" = "conflicts with main — merge it in before CI can run" ] || fail "unknown mergeable: $out"
[ "$(calls 'pr view')" = 3 ] || fail "mergeable read $(calls 'pr view') times, not 3"

echo "pr-wait-checks: all checks passed"

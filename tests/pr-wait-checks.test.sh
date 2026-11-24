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
# gh stub: head sha abc123, runs from $GH_RUNS, a run fails if named in $GH_FAIL.
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$WORK/gh-calls"
case "$1 $2" in
  "pr view") echo "abc123 ${GH_MERGEABLE:-MERGEABLE} main" ;;
  "workflow list") printf "%s" "${GH_WORKFLOWS-2}" ;;
  "run list") printf '%s\n' $GH_RUNS ;;
  "run watch") [ "$3" != "${GH_FAIL:-}" ] ;;
esac
STUB
chmod +x "$work/bin/node" "$work/bin/gh"
export PATH="$work/bin:$PATH" WORK=$work GH_RUNS="11 12"

fail() { echo "FAIL: $*"; exit 1; }
run() { rm -f "$work/gh-calls"; "$script" 7 2>&1 | tail -1; }

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

echo "pr-wait-checks: all checks passed"

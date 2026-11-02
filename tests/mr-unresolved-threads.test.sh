#!/usr/bin/env bash
# Self-check for mr-unresolved-threads.sh. Stubs `glab` with a fixed discussions
# payload and a throwaway repo, so it runs with no network, no glab and no
# GitLab. Run it after touching the sed or jq in that script.
#   tests/mr-unresolved-threads.test.sh
set -euo pipefail
cd "$(dirname "$0")"
script=$PWD/../scripts/mr-unresolved-threads.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat > "$work/discussions.json" <<'JSON'
[
 {"id":"aaa1","notes":[
   {"id":1,"body":"open","author":{"username":"alice"},"resolvable":true,"resolved":false,
    "position":{"new_path":"src/a.ts","new_line":42}},
   {"id":2,"body":"reply","author":{"username":"bob"},"resolvable":true,"resolved":false,
    "position":{"new_path":"src/a.ts","new_line":42}}]},
 {"id":"bbb2","notes":[
   {"id":3,"body":"already fixed","author":{"username":"alice"},"resolvable":true,"resolved":true,
    "position":{"new_path":"src/b.ts","new_line":7}}]},
 {"id":"ccc3","notes":[
   {"id":4,"body":"plain MR comment","author":{"username":"bob"},"resolvable":false,"resolved":false,
    "position":null}]},
 {"id":"ddd4","notes":[
   {"id":5,"body":"file was deleted by the fix","author":{"username":"amy"},"resolvable":true,"resolved":false,
    "position":{"new_path":null,"new_line":null,"old_path":"src/gone.ts","old_line":12}}]},
 {"id":"eee5","notes":[
   {"id":6,"body":"system note in front","author":{"username":"ci"},"system":true,"resolvable":false,"resolved":false,
    "position":null},
   {"id":7,"body":"open behind it","author":{"username":"amy"},"resolvable":true,"resolved":false,
    "position":{"new_path":"src/c.ts","new_line":3}}]}
]
JSON

mkdir -p "$work/bin"
cat > "$work/bin/glab" <<STUB
#!/usr/bin/env bash
echo "\$GITLAB_HOST \$*" > "$work/called"
cat "$work/discussions.json"
STUB
chmod +x "$work/bin/glab"

git init -q "$work/repo"
git -C "$work/repo" remote add origin git@github.com:mirror/thing.git
git -C "$work/repo" remote add work git@git.example.lan:group/sub/thing.git

actual=$(cd "$work/repo" && PATH="$work/bin:$PATH" bash "$script" 123)
called=$(cat "$work/called")

fail() { echo "FAIL: $1"; echo "got: $2"; exit 1; }

# It must pick the GitLab remote even though GitHub owns `origin`, and address
# the project by URL-encoded path so a nested group does not break the path.
[[ $called == "git.example.lan api projects/group%2Fsub%2Fthing/merge_requests/123/discussions?per_page=100&page=1" ]] \
  || fail "wrong glab call" "$called"

# Resolved threads and plain comments are gone; the outdated thread keeps its
# old path; a leading system note does not hide the real position or show up.
expected='[{"id":"aaa1","path":"src/a.ts","line":42,"notes":[1,2]},{"id":"ddd4","path":"src/gone.ts","line":12,"notes":[5]},{"id":"eee5","path":"src/c.ts","line":3,"notes":[7]}]'
got=$(jq -cS '[.[] | {id, path, line, notes: [.notes[].id]}]' <<<"$actual")
[[ $got == "$(jq -cS . <<<"$expected")" ]] || fail "wrong threads" "$got"

count=$(cd "$work/repo" && PATH="$work/bin:$PATH" bash "$script" 123 --count)
[[ $count == 3 ]] || fail "--count" "$count"

# A remote whose URL says gitlab wins over one that is merely not GitHub, even
# when the other sorts first. Without this, `backup` (a NAS) takes the review.
git init -q "$work/three"
git -C "$work/three" remote add origin git@github.com:mirror/thing.git
git -C "$work/three" remote add backup /Volumes/nas/thing.git
git -C "$work/three" remote add gitlab git@gitlab.example.com:group/thing.git
(cd "$work/three" && PATH="$work/bin:$PATH" bash "$script" 123 >/dev/null)
called=$(cat "$work/called")
[[ $called == "gitlab.example.com api projects/group%2Fthing/"* ]] || fail "picked the wrong remote" "$called"

# A repo with nothing but GitHub fails once, with the helper's message -- not
# twice, with an unbound-variable error behind it.
git init -q "$work/github-only"
git -C "$work/github-only" remote add origin git@github.com:mirror/thing.git
errors=$( (cd "$work/github-only" && PATH="$work/bin:$PATH" bash "$script" 123) 2>&1 >/dev/null || true)
[[ $errors == *"set GITLAB_REMOTE"* && $errors != *"unbound variable"* ]] || fail "should fail once" "$errors"

echo "ok"

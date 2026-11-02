#!/usr/bin/env bash
# Self-check for install.sh against a throwaway HOME.
#   ./install.test.sh
set -euo pipefail
cd "$(dirname "$0")"
checkout=$PWD
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $1"; exit 1; }
install() { HOME="$work" ./install.sh >/dev/null; }

# A real command of the user's own sits beside ours and must survive.
mkdir -p "$work/.claude/commands"
echo mine > "$work/.claude/commands/other.md"
# A link a previous checkout left for a file that no longer exists.
ln -s "$checkout/commands/gone.md" "$work/.claude/commands/gone.md"
# A real file where one of ours goes is moved aside, not overwritten.
echo old > "$work/.claude/commands/pr-loop.md"
# An older install linked the workflow; it must become a real copy.
mkdir -p "$work/.claude/workflows"
ln -s "$checkout/workflows/pr-loop.js" "$work/.claude/workflows/pr-loop.js"

install
for file in commands/pr-loop.md commands/mr-loop.md review/standard.md scripts/pr-unresolved-threads.sh; do
  [[ $(readlink "$work/.claude/$file") == "$checkout/$file" ]] || fail "$file not linked"
done
[[ $(cat "$work/.claude/commands/other.md") == mine ]] || fail "the user's own command was touched"
[[ ! -L $work/.claude/commands/gone.md ]] || fail "stale link kept"
compgen -G "$work/.claude/commands/pr-loop.md.backup-*" >/dev/null || fail "real file not backed up"
workflow_copied() {
  [[ ! -L $work/.claude/workflows/pr-loop.js ]] || fail "workflow not a regular file $1"
  cmp -s workflows/pr-loop.js "$work/.claude/workflows/pr-loop.js" || fail "workflow copy differs from the checkout $1"
}
workflow_copied "after replacing the old link"

# A second run leaves the same links and refreshes a stale workflow copy.
echo stale > "$work/.claude/workflows/pr-loop.js"
install
workflow_copied "after a re-run over a stale copy"
compgen -G "$work/.claude/workflows/pr-loop.js.backup-*" >/dev/null || fail "edited workflow copy not backed up"
# An untouched copy of an older release is replaced without a backup.
if [ -d .git ]; then
  rm -f "$work/.claude/workflows/pr-loop.js".backup-*
  git show "$(git log --format=%H -- workflows/pr-loop.js | tail -1):workflows/pr-loop.js" > "$work/.claude/workflows/pr-loop.js"
  install
  workflow_copied "after a re-run over an older release"
  ! compgen -G "$work/.claude/workflows/pr-loop.js.backup-*" >/dev/null || fail "unedited older workflow copy backed up"
fi
[[ $(readlink "$work/.claude/commands/pr-loop.md") == "$checkout/commands/pr-loop.md" ]] || fail "second run broke a link"
echo ok

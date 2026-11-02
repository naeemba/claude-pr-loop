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

install
for file in commands/pr-loop.md commands/mr-loop.md workflows/pr-loop.js review/standard.md scripts/pr-unresolved-threads.sh; do
  [[ $(readlink "$work/.claude/$file") == "$checkout/$file" ]] || fail "$file not linked"
done
[[ ! -e $work/.claude/scripts/mr-unresolved-threads.test.sh ]] || fail "test script was installed"
[[ $(cat "$work/.claude/commands/other.md") == mine ]] || fail "the user's own command was touched"
[[ ! -L $work/.claude/commands/gone.md ]] || fail "stale link kept"
compgen -G "$work/.claude/commands/pr-loop.md.backup-*" >/dev/null || fail "real file not backed up"

# A second run changes nothing and nests nothing.
install
[[ ! -e $checkout/commands/commands ]] || fail "second run nested a link"
echo ok

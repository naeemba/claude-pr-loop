#!/usr/bin/env bash
# Link every command, the workflow, the review standard and the helper scripts
# into ~/.claude, one file at a time, so they sit next to whatever else is
# already there and stay plain `/pr-loop`, `/pr-review`, ... (a plugin would
# namespace them as `/<plugin>:pr-loop`). Each link points back into this
# checkout, so a `git pull` here updates the installed copy. Safe to re-run.
#
#   ./install.sh
set -euo pipefail
cd "$(dirname "$0")"
checkout=$PWD
target=$HOME/.claude

# Move a real file aside instead of overwriting it; replace an old link.
link_into_place() {
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    mv "$2" "$2.backup-$(date +%Y%m%d%H%M%S)"
  fi
  ln -sfn "$1" "$2"
}

for file in commands/*.md workflows/*.js review/*.md scripts/*.sh; do
  mkdir -p "$target/$(dirname "$file")"
  link_into_place "$checkout/$file" "$target/$file"
done
# A link left for a file this checkout no longer has would still show up as a
# command that fails on its first read. (Not `find -xtype`: macOS lacks it.)
for link in "$target"/{commands,workflows,review,scripts}/*; do
  if [ -L "$link" ] && [ ! -e "$link" ] && [[ $(readlink "$link") == "$checkout/"* ]]; then
    rm "$link"
  fi
done

echo "Linked into $target. A new session picks up /pr-loop and the other commands."

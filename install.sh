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

for directory in commands workflows scripts review; do
  mkdir -p "$target/$directory"
  # A link left by an older checkout whose file is gone would still show up
  # as a command that fails on its first read.
  for link in "$target/$directory"/*; do
    if [ -L "$link" ] && [ ! -e "$link" ] && [[ $(readlink "$link") == "$checkout/"* ]]; then
      rm "$link"
    fi
  done
done

for file in commands/*.md workflows/*.js review/*.md scripts/*.sh; do
  case $file in *.test.sh) continue ;; esac
  link_into_place "$checkout/$file" "$target/$file"
done

echo "Linked into $target. A new session picks up /pr-loop and the other commands."

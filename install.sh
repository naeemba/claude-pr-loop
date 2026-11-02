#!/usr/bin/env bash
# Link every command, the review standard and the helper scripts into
# ~/.claude, one file at a time, so they sit next to whatever else is already
# there and stay plain `/pr-loop`, `/pr-review`, ... (a plugin would namespace
# them as `/<plugin>:pr-loop`). Each link points back into this checkout, so a
# `git pull` here updates them. The workflow is copied instead, since the
# Workflow tool refuses a link into an unreadable checkout (see README). Safe to
# re-run.
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

for file in commands/*.md review/*.md scripts/*.sh; do
  mkdir -p "$target/$(dirname "$file")"
  link_into_place "$checkout/$file" "$target/$file"
done
mkdir -p "$target/workflows"
# True when the installed copy is a version this checkout once shipped, so an
# untouched copy of an older release is not mistaken for an edit. Without git
# history, only a copy identical to the current file counts.
shipped_here() {
  if [ -d .git ]; then
    # Match the blob in the raw diff text rather than piping into `grep -q`,
    # whose early exit would fail the pipeline under pipefail.
    [[ $(git log --all --format= --raw --no-abbrev -- "$1") == *" $(git hash-object "$2") "* ]]
  else
    cmp -s "$1" "$2"
  fi
}
for file in workflows/*.js; do
  # Keep an edited copy aside, as link_into_place does; rm the rest so a link
  # left by an older install is replaced, not written through.
  if [ -f "$target/$file" ] && [ ! -L "$target/$file" ] && ! cmp -s "$file" "$target/$file" && ! shipped_here "$file" "$target/$file"; then
    mv "$target/$file" "$target/$file.backup-$(date +%Y%m%d%H%M%S)"
  fi
  rm -f "$target/$file"
  cp "$file" "$target/$file"
done
# A link left for a file this checkout no longer has would still show up as a
# command that fails on its first read. (Not `find -xtype`: macOS lacks it.)
for link in "$target"/{commands,workflows,review,scripts}/*; do
  if [ -L "$link" ] && [ ! -e "$link" ] && [[ $(readlink "$link") == "$checkout/"* ]]; then
    rm "$link"
  fi
done

echo "Installed into $target. Re-run after a git pull to refresh the workflow copy. A new session picks up /pr-loop and the other commands."

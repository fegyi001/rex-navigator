#!/bin/sh
# Fast local checks: no Rex executable, server connection, or fzf required.
set -eu

script_dir=${0%/*}
if [ "$script_dir" = "$0" ]; then script_dir=.; fi
CDPATH= cd -- "$script_dir/.."

for tool in node lua luac; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Local checks require %s in PATH; see CONTRIBUTING.md\n' "$tool" >&2
    exit 1
  fi
done

for file in init.lua lua/navigation/*.lua scripts/*.lua tests/helpers/*.lua; do
  luac -p "$file"
done
for file in scripts/*.sh; do
  sh -n "$file"
done

exec node --test tests/standalone/*.test.mjs tests/rex-navigator-window.test.mjs

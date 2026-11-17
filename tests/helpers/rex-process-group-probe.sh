#!/bin/sh
# Scratch-only capability probe: run one child in an isolated job-control group.
set -m
child=
cleanup() {
  trap '' TERM INT HUP
  if [ -n "$child" ]; then
    /bin/kill -TERM -- "-$child" 2>/dev/null || :
    /bin/sleep 0.05
    /bin/kill -KILL -- "-$child" 2>/dev/null || :
    wait "$child" 2>/dev/null || :
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
"$@" <&0 &
child=$!
wait "$child"
status=$?
exit "$status"

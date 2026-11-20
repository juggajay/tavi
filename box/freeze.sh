#!/bin/bash
# Stop or continue every process belonging to a bot group member.
set -uo pipefail
case "${1:-}" in stop) signal=STOP;; continue) signal=CONT;; *) exit 2;; esac
failed=0
while IFS=: read -r user _ uid _; do
  if id -Gn "$user" | tr ' ' '\n' | grep -qx lhbots; then
    pkill -"$signal" -u "$uid" || { [ "$?" = 1 ] || failed=1; }
  fi
done < /etc/passwd
exit "$failed"

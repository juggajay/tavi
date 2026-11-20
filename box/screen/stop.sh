#!/bin/bash
# Only the root guard uses this. Match the whole command for this user's one screen or browser.
set -euo pipefail
[[ "${1:-}" =~ ^bot-[a-z0-9][a-z0-9-]{0,24}$ ]] || exit 2
case "${2:-}" in
  browser) pattern='chrome-linux64/chrome|/opt/lh/run-browser.sh' ;;
  screen) pattern='Xvnc|openbox|tint2|/opt/lh/run-screen.sh' ;;
  *) exit 2 ;;
esac
pkill -KILL -u "$1" -f "$pattern" || [ "$?" = 1 ]
for attempt in {1..20}; do
  pgrep -u "$1" -f "$pattern" >/dev/null || exit 0
  sleep 0.1
done
exit 1

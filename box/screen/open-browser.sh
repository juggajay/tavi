#!/bin/bash
set -euo pipefail
[[ $# == 0 ]] || exit 2
[ "$(id -u)" != 0 ]
[[ "${DISPLAY:-}" =~ ^:[1-9][0-9]?$ ]] || exit 2
browser=$(printf '%s\n' /opt/hermes/tools/chromium-*/chrome-linux64/chrome | sort -V | tail -n1)
[ -x "$browser" ]
exec "$browser" --user-data-dir="$HOME/chrome-profile" --new-tab 'chrome://newtab/'

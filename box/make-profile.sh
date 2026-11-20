#!/bin/bash
# Make a profile once. Run as the team user.
set -euo pipefail
PROFILE_ID="${1:?bot name}"
[[ "$PROFILE_ID" =~ ^[a-z0-9][a-z0-9-]{0,24}$ ]] || { echo "Choose a short bot name." >&2; exit 2; }
case "$PROFILE_ID" in default|root|hermes) echo "That name is reserved." >&2; exit 2;; esac
export HERMES_HOME=/srv/lh/team
cd "$HERMES_HOME"
[ ! -L profiles ] && [ ! -L "profiles/$PROFILE_ID" ] || exit 1
if [ ! -d "profiles/$PROFILE_ID" ]; then
  /opt/hermes/.local/bin/hermes profile create "$PROFILE_ID"
fi
echo "$HERMES_HOME/profiles/$PROFILE_ID"

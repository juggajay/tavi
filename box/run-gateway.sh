#!/bin/bash
set -euo pipefail
export HERMES_HOME=/srv/lh/team
export HERMES_GATEWAY_LOCK_DIR=/srv/lh/team/locks
mkdir -p "$HERMES_GATEWAY_LOCK_DIR"
cd /srv/lh/team
exec /opt/hermes/.local/bin/hermes gateway run --no-supervise

#!/bin/bash
# Make a bot's own home and work folder. Run as root.
set -euo pipefail
USER_NAME="${1:?bot user name}"
case "$USER_NAME" in bot-[a-z0-9]*) ;; *) echo "user must look like bot-<name>" >&2; exit 2 ;; esac
[[ "$USER_NAME" =~ ^bot-[a-z0-9][a-z0-9-]{0,24}$ ]] || { echo "Choose a short bot user name." >&2; exit 2; }

getent passwd "$USER_NAME" >/dev/null || useradd --create-home --shell /bin/bash --gid lhbots "$USER_NAME"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
[ ! -L "$HOME_DIR" ] && [ ! -L "$HOME_DIR/work" ] || exit 1
chmod 700 "$HOME_DIR"
runuser -u "$USER_NAME" -- mkdir -p "$HOME_DIR/work"
runuser -u "$USER_NAME" -- chmod 700 "$HOME_DIR/work"
echo "$HOME_DIR"

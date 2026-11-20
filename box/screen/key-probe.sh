#!/bin/bash
# Root asks the team to try its key. The private part is never sent back to Windows.
set -euo pipefail
[[ "${1:-}" =~ ^bot-[a-z0-9][a-z0-9-]{0,24}$ ]] || exit 2
key="/srv/lh/team/keys/${1#bot-}"
result=$(runuser -u lh-team -- ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/srv/lh/team/.ssh/known_hosts \
  -o ConnectTimeout=3 -p 2222 -i "$key" "$1@127.0.0.1" 'id -un')
[ "$result" = "$1" ]
if runuser -u lh-team -- ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/srv/lh/team/.ssh/known_hosts \
  -o ConnectTimeout=3 -p 2222 -i "$key" bot-probe@127.0.0.1 true >/dev/null 2>&1; then exit 1; fi
if runuser -u "$1" -- test -r "$key"; then exit 1; fi
echo 'ok    the key opens only its own bot and the bot cannot read the key'

#!/bin/bash
# Run as lh-team. The private key stays here and is never printed.
set -euo pipefail
[[ "${1:-}" =~ ^[a-z0-9][a-z0-9-]{0,24}$ ]] || exit 2
[ "$(id -un)" = lh-team ]
umask 077
cd /srv/lh/team
[ ! -L keys ]
mkdir -p keys
chmod 700 keys
[ ! -L "keys/$1" ] && [ ! -L "keys/$1.pub" ]
if [ ! -e "keys/$1" ]; then ssh-keygen -q -t ed25519 -N '' -f "keys/$1" > /dev/null; fi
chmod 600 "keys/$1"
ssh-keygen -y -f "keys/$1" > "keys/$1.pub"
chmod 600 "keys/$1.pub"
mkdir -p .ssh
chmod 700 .ssh
# Pin the local server's public key; do not accept an unknown machine's key on first use.
[ ! -L .ssh/known_hosts ]
awk '{print "[127.0.0.1]:2222 " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub > .ssh/known_hosts
chmod 600 .ssh/known_hosts

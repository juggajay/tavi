#!/bin/bash
# One-time (and repeatable) setup of the bots' Linux space. Run as root from the folder
# holding wsl.conf and boot.sh:   bash setup.sh
# It installs only ordinary Ubuntu packages, puts the lock-down files in place, and makes the
# group every bot user belongs to. Hermes itself is installed by install-hermes.sh.
set -euo pipefail
cd "$(dirname "$0")"
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y -q --no-install-recommends \
  iptables iproute2 procps curl ca-certificates git python3 xz-utils tar psmisc

getent group lhbots >/dev/null || groupadd --system lhbots

install -d -m 755 -o root -g root /opt/lh
install -m 644 -o root -g root wsl.conf /etc/wsl.conf
install -m 700 -o root -g root boot.sh /opt/lh/boot.sh
[ -f /opt/lh/toolbox-port ] || echo 3090 > /opt/lh/toolbox-port
chmod 644 /opt/lh/toolbox-port

# nobody gets sudo in here
rm -f /etc/sudoers.d/* 2>/dev/null || true
if getent group sudo >/dev/null; then
  for u in $(getent group sudo | awk -F: '{print $4}' | tr ',' ' '); do gpasswd -d "$u" sudo >/dev/null || true; done
fi

echo "setup done: restart the space (wsl --terminate lh-bots) for wsl.conf and boot.sh to take effect"

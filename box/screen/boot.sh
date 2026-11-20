#!/bin/bash
# Run as root on each start. Missing saved screens means deny every reserved port.
set -euo pipefail
[ "$(id -u)" = 0 ]
command -v sshd >/dev/null
command -v rsvg-convert >/dev/null
command -v Xvnc >/dev/null
getent passwd lh-team >/dev/null
install -d -m 700 /var/lib/lh-screen
install -d -m 755 /etc/lh/keys
if [ -f /var/lib/lh-screen/ports ]; then
  rows=$(cat /var/lib/lh-screen/ports)
  printf '%s\n' "$rows" | bash /opt/lh/fence.sh apply
else
  bash /opt/lh/fence.sh apply < /dev/null
fi
install -d -m 755 /run/sshd
ssh-keygen -A >/dev/null
cat > /etc/lh/sshd_config <<'CONF'
ListenAddress 127.0.0.1
Port 2222
PidFile /run/lh-screen-sshd.pid
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
UsePAM yes
AllowGroups lhbots
AuthorizedKeysFile /etc/lh/keys/%u
StrictModes yes
DisableForwarding yes
AllowAgentForwarding no
AllowTcpForwarding no
AllowStreamLocalForwarding no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
PermitUserRC no
PermitTTY no
LogLevel ERROR
CONF
/usr/sbin/sshd -t -f /etc/lh/sshd_config
# A live sshd keeps using the same locked settings; validate its command before trusting a pid file.
if [ -f /run/lh-screen-sshd.pid ]; then
  pid=$(cat /run/lh-screen-sshd.pid)
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q '/etc/lh/sshd_config'; then
    exit
  fi
fi
/usr/sbin/sshd -f /etc/lh/sshd_config

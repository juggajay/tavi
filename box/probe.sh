#!/bin/bash
# The lock-down check. Run as a BOT user (never root): every line must end in "ok".
# Used by tests and by the guard before any bot is allowed to start.
#   wsl -d lh-bots -u <botuser> -- bash /opt/lh/probe.sh [toolbox-port]
fail=0
ok()  { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }
check() { if eval "$2" >/dev/null 2>&1; then bad "$1"; else ok "$1"; fi; }   # passes when the command FAILS

[ "$(id -u)" -ne 0 ] && ok "not root" || bad "running as root"
check "no sudo"                       'sudo -n true'
check "cannot list the team home"     'ls /srv/lh/team'
check "cannot read team sign-ins"     'cat /srv/lh/team/auth.json'
check "C: drive not visible"          'ls /mnt/c/Windows'
check "D: drive not visible"          'ls /mnt/d/*'
check "no Windows mounts"             'mount | grep -Eq "drvfs|aname=drvfs"'
check "Windows display bridge shut"   'ls /mnt/wslg/'
check "no X socket from Windows"      'ls /tmp/.X11-unix/X0'
check "interop sockets shut"          'ls /run/WSL/'
check "cannot start Windows programs" '/init /mnt/c/Windows/System32/cmd.exe /c ver | grep -qi windows'
check "cannot mount"                  'mount -t drvfs C: /tmp'
check "cannot read other disks"       'head -c 16 /dev/sda'
check "cannot change the firewall"    'iptables -F LHBOTS'
check "cannot edit lock-down files"   'touch /etc/wsl.conf'

HOST="$(ip route show default | awk '{print $3; exit}')"
PORT="${1:-$(cat /opt/lh/toolbox-port 2>/dev/null || echo 3090)}"
open() { timeout 3 bash -c "echo > /dev/tcp/$1/$2" 2>/dev/null; }
for p in 22 135 139 445 3077 3081 3389 3877 5985 8080; do
  check "PC port $p refused" "open $HOST $p"
done
LAN_GW="$(echo "$HOST" | sed 's/\.[0-9]*$/.2/')"
check "private network refused (192.168.1.1)" 'open 192.168.1.1 80'
check "private network refused (10.0.0.1)"    'open 10.0.0.1 80'
check "tailscale range refused (100.100.100.100)" 'open 100.100.100.100 80'
if curl -s -o /dev/null -m 10 https://api.openai.com/v1/models; then ok "internet reachable"; else bad "internet NOT reachable"; fi
printf 'info  PC address %s, toolbox port %s: %s\n' "$HOST" "$PORT" "$(open "$HOST" "$PORT" && echo reachable || echo 'not answering (fine until the toolbox runs)')"
exit $fail

#!/bin/bash
# Runs as root every time the bots' Linux space starts (wsl.conf [boot] command).
# Closes the doors wsl.conf cannot: the shared Windows display, the interop sockets,
# and the network routes from in here to the PC and the home network.
# Writes what it did to /var/log/lh-boot.log. Never fails the boot: each step stands alone.

LOG=/var/log/lh-boot.log
say() { printf '%s %s\n' "$(date -Is)" "$1" >> "$LOG"; }
: > "$LOG"; chmod 600 "$LOG"
say "boot start"

# 1. The Windows display/clipboard bridge (WSLg). Bots get their own screens (Xvnc); they must
#    never reach the PC's desktop, clipboard or sound through this.
for m in /tmp/.X11-unix /mnt/wslg/run/user/* /mnt/wslg/doc /mnt/wslg/versions.txt /mnt/wslg/distro /mnt/wslg; do
  mountpoint -q "$m" 2>/dev/null && umount -l "$m" 2>/dev/null && say "unmounted $m"
done
[ -d /mnt/wslg ] && chmod 000 /mnt/wslg 2>/dev/null
mkdir -p /tmp/.X11-unix && chown root:root /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# 2. The sockets Windows programs are started through. Interop is off in wsl.conf; remove the
#    sockets as well and take the folder away from everyone but root.
if [ -d /run/WSL ]; then
  rm -f /run/WSL/*_interop 2>/dev/null
  chmod 700 /run/WSL 2>/dev/null
  say "closed /run/WSL"
fi
[ -e /proc/sys/fs/binfmt_misc/WSLInterop ] && echo 0 > /proc/sys/fs/binfmt_misc/WSLInterop 2>/dev/null
[ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ] && echo 0 > /proc/sys/fs/binfmt_misc/WSLInterop-late 2>/dev/null

# 3. Any Windows drive that got mounted anyway.
for m in /mnt/[a-z]; do
  mountpoint -q "$m" 2>/dev/null && umount -l "$m" 2>/dev/null && say "unmounted $m"
done
mountpoint -q /usr/lib/wsl/drivers 2>/dev/null && umount -l /usr/lib/wsl/drivers 2>/dev/null && say "unmounted windows drivers"

# 4. Network. Bots may reach the internet. They may reach the PC on exactly one port: the toolbox
#    (where every tool call is checked). Everything else on the PC, the home network and the
#    Tailscale network is refused. Rules are for the bot users' group only, so root can still update.
if command -v iptables >/dev/null 2>&1; then
  HOSTIP="$(ip route show default 2>/dev/null | awk '{print $3; exit}')"
  TOOLBOX_PORT="$(cat /opt/lh/toolbox-port 2>/dev/null || echo 3090)"
  iptables -F LHBOTS 2>/dev/null || iptables -N LHBOTS
  iptables -C OUTPUT -m owner --gid-owner lhbots -j LHBOTS 2>/dev/null || iptables -A OUTPUT -m owner --gid-owner lhbots -j LHBOTS
  iptables -A LHBOTS -o lo -j ACCEPT
  [ -n "$HOSTIP" ] && iptables -A LHBOTS -d "$HOSTIP" -p tcp --dport "$TOOLBOX_PORT" -j ACCEPT
  # name lookups go to the address WSL hands out
  for ns in $(awk '/^nameserver/{print $2}' /etc/resolv.conf); do
    iptables -A LHBOTS -d "$ns" -p udp --dport 53 -j ACCEPT
    iptables -A LHBOTS -d "$ns" -p tcp --dport 53 -j ACCEPT
  done
  for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 224.0.0.0/4; do
    iptables -A LHBOTS -d "$net" -j REJECT
  done
  iptables -A LHBOTS -j ACCEPT
  # the same for IPv6: local and private ranges refused
  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -F LHBOTS 2>/dev/null || ip6tables -N LHBOTS
    ip6tables -C OUTPUT -m owner --gid-owner lhbots -j LHBOTS 2>/dev/null || ip6tables -A OUTPUT -m owner --gid-owner lhbots -j LHBOTS
    ip6tables -A LHBOTS -o lo -j ACCEPT
    for net in fc00::/7 fe80::/10 ff00::/8; do ip6tables -A LHBOTS -d "$net" -j REJECT; done
    ip6tables -A LHBOTS -j ACCEPT
  fi
  say "network rules set (host $HOSTIP, toolbox port $TOOLBOX_PORT)"
else
  say "WARNING: iptables missing, network rules NOT set"
fi

# 5. Hermes tightens its own folder to owner-only whenever its owner runs it (an install or repair).
#    Bots must be able to read and run it (never write), so open it again on every start.
[ -d /opt/hermes ] && chmod 755 /opt/hermes && say "opened /opt/hermes for reading"

say "boot done"
exit 0

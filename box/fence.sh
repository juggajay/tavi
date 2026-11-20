#!/bin/bash
# Run as root. The whole new list replaces the old one in one step per address family.
set -euo pipefail
[[ "${1:-}" = apply || "${1:-}" = rules ]] || exit 2
rows=()
declare -A users=() ports=()
while read -r user vnc cdp extra; do
  [ -n "$user" ] || continue
  [[ "$user" =~ ^bot-[a-z0-9][a-z0-9-]{0,24}$ && "$vnc" =~ ^[0-9]{4}$ && "$cdp" =~ ^[0-9]{4}$ && -z "$extra" ]] || exit 2
  (( vnc >= 5911 && vnc <= 6009 && cdp == vnc + 3300 )) || exit 2
  [[ -z "${users[$user]:-}" && -z "${ports[$vnc]:-}" ]] || exit 2
  users[$user]=1; ports[$vnc]=1; rows+=("$user $vnc $cdp")
done
rules() {
  echo '-A LHFENCE -o lo -p tcp -m owner --uid-owner lh-team --dport 2222 -j RETURN'
  if ((${#rows[@]})); then
    while read -r user vnc cdp; do
      echo "-A LHFENCE -o lo -p tcp -m owner --uid-owner lh-team --dport $cdp -j RETURN"
      echo "-A LHFENCE -o lo -p tcp -m owner --uid-owner $user --dport $vnc -j RETURN"
    done < <(printf '%s\n' "${rows[@]}" | LC_ALL=C sort)
  fi
  for protocol in tcp udp; do
    for port in 2222 5910:6009 8650:8749 9210:9309; do
      echo "-A LHFENCE -o lo -p $protocol -m owner --gid-owner lhbots --suppl-groups --dport $port -j REJECT"
    done
  done
}
if [ "$1" = rules ]; then rules; exit; fi
[ "$(id -u)" = 0 ]
for tool in iptables ip6tables iptables-restore ip6tables-restore; do command -v "$tool" >/dev/null; done
getent passwd lh-team >/dev/null
for user in "${!users[@]}"; do id -Gn "$user" | tr ' ' '\n' | grep -qx lhbots; done
for tool in iptables ip6tables; do
  "$tool" -w -N LHFENCE 2>/dev/null || "$tool" -w -S LHFENCE >/dev/null
  # Put the fence before the old loopback allowance, with no moment without a hook.
  "$tool" -w -I OUTPUT 1 -j LHFENCE
  while [ "$("$tool" -S OUTPUT | grep -cx -- '-A OUTPUT -j LHFENCE')" -gt 1 ]; do
    line=$("$tool" -L OUTPUT --line-numbers -n | awk '$2=="LHFENCE" {n=$1} END {print n}')
    "$tool" -w -D OUTPUT "$line"
  done
  { echo '*filter'; echo '-F LHFENCE'; rules; echo COMMIT; } | "${tool}-restore" -w --noflush
done
install -d -m 700 /var/lib/lh-screen
printf '%s\n' "${rows[@]}" > /var/lib/lh-screen/ports
chmod 600 /var/lib/lh-screen/ports

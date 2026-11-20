#!/bin/bash
# This rule comes before the existing toolbox allowance.
set -euo pipefail
case "${1:-}" in open|close) ;; *) exit 2;; esac
port="$(cat /opt/lh/toolbox-port 2>/dev/null || echo 3090)"
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((port > 0 && port < 65536)) || exit 2
rule=(-p tcp --dport "$port" -m comment --comment lh-guard -j REJECT)
for tool in iptables ip6tables; do
  command -v "$tool" >/dev/null || { [ "$tool" = ip6tables ] && continue; exit 1; }
  "$tool" -S LHBOTS >/dev/null
  while "$tool" -C LHBOTS "${rule[@]}" 2>/dev/null; do "$tool" -D LHBOTS "${rule[@]}"; done
  [ "$1" = open ] || "$tool" -I LHBOTS 1 "${rule[@]}"
done

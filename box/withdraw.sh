#!/bin/bash
# Remove every sign-in. Keep going if one place cannot be cleaned.
#
# Only ever looks beside the settings files (a Hermes home and its profiles, two levels deep at
# most) and never inside Hermes' own program files (installs, tools, cache, skills): those hold
# dozens of ordinary files with "token" in the name, and removing them would break Hermes for good.
set -uo pipefail
failed=0

clean_home() {   # $1 = a Hermes home (the team root, a profile, or an old per-bot home)
  local home="$1"
  [ -d "$home" ] && [ ! -L "$home" ] || return 0
  rm -f -- "$home/auth.json" "$home/.anthropic_oauth.json" || failed=1
  find -P "$home" -mindepth 1 -maxdepth 2 \
    \( -name installs -o -name tools -o -name cache -o -name skills -o -name profiles -o -name sessions -o -name logs \) -prune \
    -o \( -iname '*token*' -o -iname '*oauth*.json' \) \( -type f -o -type l \) -exec rm -f -- {} + || failed=1
}

clean_home /srv/lh/team
if [ -d /srv/lh/team/profiles ] && [ ! -L /srv/lh/team/profiles ]; then
  for profile in /srv/lh/team/profiles/*/; do
    [ -d "$profile" ] && clean_home "${profile%/}"
  done
fi
while IFS=: read -r user _ _ _ _ home _; do
  [[ "$user" =~ ^bot-[a-z0-9][a-z0-9-]{0,30}$ ]] || continue
  clean_home "$home/hermes"
done < /etc/passwd
exit "$failed"

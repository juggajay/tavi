#!/bin/bash
# Make the team's private home. Run as root. Existing sign-ins and profiles stay as they are.
set -euo pipefail
getent passwd lh-team >/dev/null || useradd --system --home-dir /srv/lh/team --shell /bin/bash --gid lhbots lh-team
[ "$(id -gn lh-team)" = lhbots ] || { echo "The team must belong to the bot group." >&2; exit 1; }
install -d -m 755 -o root -g root /srv/lh
[ ! -L /srv/lh/team ] || exit 1
install -d -m 700 -o lh-team -g lhbots /srv/lh/team
if [ ! -e /srv/lh/team/installs ]; then
  # Finish the copy before putting it in use.
  staging="$(mktemp -d /srv/lh/install-copy.XXXXXX)"
  trap 'rm -rf -- "$staging"' EXIT
  cp -a /opt/hermes/installs "$staging/installs"
  sed -i 's#/opt/hermes/installs/#/srv/lh/team/installs/#g' "$staging"/installs/*/facts.json
  chown -R lh-team:lhbots "$staging/installs"
  chmod -R u+rwX,go-rwx "$staging/installs"
  mv -T -n "$staging/installs" /srv/lh/team/installs
fi
if [ ! -e /srv/lh/team/tools ] && [ ! -L /srv/lh/team/tools ]; then
  ln -s /opt/hermes/tools /srv/lh/team/tools
  chown -h lh-team:lhbots /srv/lh/team/tools
fi
echo /srv/lh/team

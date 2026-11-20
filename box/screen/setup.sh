#!/bin/bash
# Run by the reviewer as root, once, from the box folder: bash screen/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(id -u)" = 0 ]
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends openssh-server librsvg2-bin \
  tigervnc-standalone-server tigervnc-tools openbox tint2 xterm xdotool wmctrl \
  feh dbus-x11 xauth x11-utils fonts-dejavu-core adwaita-icon-theme
install -d -m 755 /opt/lh/screen
install -m 755 fence.sh run-screen.sh run-browser.sh /opt/lh/
for file in screen/*.sh screen/*.py; do install -m 755 "$file" /opt/lh/screen/; done
install -m 644 screen/openbox.xml screen/tint2rc screen/extension.json /opt/lh/screen/
# The space's own settings file (box/wsl.conf) runs the lock-down boot step, then the screen boot step.
install -m 644 -o root -g root wsl.conf /etc/wsl.conf
echo 'Screen setup is ready. Restart lh-bots before trying the screens.'

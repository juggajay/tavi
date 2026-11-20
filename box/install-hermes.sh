#!/bin/bash
# Installs Hermes Agent into the bots' Linux space at one fixed version. Run as root:
#   bash install-hermes.sh /path/to/install.sh
# The installer script is Hermes' own (hermes-agent.nousresearch.com/install.sh), passed in as a
# file so that what runs is the copy that was read first.
#
# Layout: /opt/hermes is the home of the user "hermes" and Hermes own data root, with the code in
# /opt/hermes/hermes-agent (Hermes standard layout: a bot started with its own HERMES_HOME then
# borrows this install, see pm/environments.py owning_home_root). Bot users may read and run it but
# not change it; each bot keeps its own settings, sign-ins and memory in its own home.
set -euo pipefail

PIN_TAG="v0.23.2"
PIN_COMMIT="ae2a81ccc00e9b7c06301523e5bb09608397149c"
INSTALLER="${1:?path to Hermes install.sh}"
export DEBIAN_FRONTEND=noninteractive

apt-get install -y -q --no-install-recommends libatomic1 ripgrep ffmpeg >/dev/null

getent passwd hermes >/dev/null || useradd --system --create-home --home-dir /opt/hermes --shell /bin/bash hermes
install -m 755 -o hermes -g hermes "$INSTALLER" /opt/hermes/install.sh

run() { runuser -u hermes -- env HOME=/opt/hermes HERMES_HOME=/opt/hermes bash /opt/hermes/install.sh "$@"; }
COMMON=(--hermes-home /opt/hermes --non-interactive --skip-browser --skip-computer-use --verbose)

if ! run --commit "$PIN_COMMIT" "${COMMON[@]}"; then
  echo "pinned-commit install refused; installing the stable channel and checking it is $PIN_TAG"
  run --channel stable "${COMMON[@]}"
fi

HEAD_NOW="$(runuser -u hermes -- git -C /opt/hermes/hermes-agent rev-parse HEAD)"
if [ "$HEAD_NOW" != "$PIN_COMMIT" ]; then
  echo "WRONG VERSION: installed $HEAD_NOW, wanted $PIN_TAG ($PIN_COMMIT)" >&2
  exit 3
fi

# The browser and the screen-control driver, into the shared store.
runuser -u hermes -- env HOME=/opt/hermes HERMES_HOME=/opt/hermes /opt/hermes/.local/bin/hermes pm install chromium cua-driver

# Bots can read and run it, never change it. Hermes resets /opt/hermes to owner-only each time its
# owner runs it, so this must come last (boot.sh repeats the top-level chmod on every start).
chmod -R go+rX /opt/hermes
chmod -R go-w /opt/hermes
chmod 755 /opt/hermes
echo "$PIN_TAG $PIN_COMMIT" > /opt/lh/hermes-version
echo "hermes installed at $PIN_TAG"

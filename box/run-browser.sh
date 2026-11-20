#!/bin/bash
# The browser stays under its bot's user. Its own safety sandbox stays on.
set -euo pipefail
[[ $# == 2 ]] || exit 2
[[ "${1:-}" =~ ^[0-9]{1,2}$ && "${2:-}" =~ ^[0-9]{4}$ ]] || exit 2
(( $1 >= 1 && $1 <= 99 && $2 == 9210 + $1 )) || exit 2
[ "$(id -u)" != 0 ]
export DISPLAY=:$1 XAUTHORITY="$HOME/.vnc/Xauthority"
unset WAYLAND_DISPLAY PULSE_SERVER DBUS_SESSION_BUS_ADDRESS
ready=false
for attempt in {1..100}; do
  if xdpyinfo >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.1
done
[ "$ready" = true ]
browser=$(printf '%s\n' /opt/hermes/tools/chromium-*/chrome-linux64/chrome | sort -V | tail -n1)
[ -x "$browser" ]
# Leave room for the wallpaper and bottom bar at any supported screen size.
read -r width height < <(xdpyinfo | awk '/dimensions:/ {split($2, size, "x"); print size[1], size[2]; exit}')
[[ "$width" =~ ^[0-9]+$ && "$height" =~ ^[0-9]+$ ]] || exit 2
window_width=$((width * 90 / 100)); window_height=$((height - 144))
(( window_width >= 300 )) || window_width=300
(( window_height >= 160 )) || window_height=160
left=$(((width - window_width) / 2)); top=$(((height - 64 - window_height) / 2))
(( top >= 0 )) || top=0
# Screen setup writes the extension before the browser starts.
for attempt in {1..100}; do
  [ ! -f "$HOME/.vnc/desk-ready" ] || break
  sleep 0.1
done
[ -s "$HOME/.local/share/tavi-home/home.js" ]
[ -f "$HOME/.vnc/desk-ready" ]
# The browser is asked for its home page before it has finished loading the add-on that holds it, and refuses
# ("blocked"). A page opened a moment later loads. So once the window is up, the first page is asked for again.
(
  for attempt in {1..150}; do
    xdotool search --onlyvisible --class chrome >/dev/null 2>&1 && break
    sleep 0.2
  done
  sleep 3
  xdotool key --clearmodifiers F5
) >/dev/null 2>&1 &
exec "$browser" --user-data-dir="$HOME/chrome-profile" --remote-debugging-port="$2" \
  --remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check \
  --load-extension="$HOME/.local/share/tavi-home" --disable-features=DisableLoadExtensionCommandLineSwitch --disable-gpu \
  --window-size="$window_width,$window_height" --window-position="$left,$top" \
  'chrome-extension://edckcealbnlgipblljdilomlmgphefii/home.html'

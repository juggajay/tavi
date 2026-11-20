#!/bin/bash
# Keep this call open for the whole life of the screen.
set -euo pipefail
[[ $# == 4 ]] || exit 2
[[ "${1:-}" =~ ^[0-9]{1,2}$ && "${2:-}" =~ ^[0-9]{4}$ && "${3:-}" =~ ^[0-9]{3,4}$ && "${4:-}" =~ ^[0-9]{3,4}$ ]] || exit 2
(( $1 >= 1 && $1 <= 99 && $2 == 5910 + $1 && $3 >= 320 && $3 <= 3840 && $4 >= 200 && $4 <= 2160 )) || exit 2
[ "$(id -u)" != 0 ]
umask 077
export DISPLAY=:$1 XAUTHORITY="$HOME/.vnc/Xauthority"
unset WAYLAND_DISPLAY PULSE_SERVER DBUS_SESSION_BUS_ADDRESS
[ -s "$HOME/.vnc/passwd" ]
rm -f "$HOME/.vnc/desk-ready"
touch "$XAUTHORITY"; chmod 600 "$XAUTHORITY"
cookie=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
printf 'add %s . %s\n' "$DISPLAY" "$cookie" | xauth -f "$XAUTHORITY" source -
unset cookie
pids=()
cleanup() { trap - EXIT TERM INT; ((${#pids[@]} == 0)) || kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT TERM INT
Xvnc "$DISPLAY" -geometry "${3}x${4}" -depth 24 -rfbport "$2" -localhost=1 \
  -SecurityTypes VncAuth -PasswordFile "$HOME/.vnc/passwd" -AlwaysShared \
  -auth "$XAUTHORITY" -nolisten tcp -AcceptCutText=0 -SendCutText=1 &
pids+=("$!")
ready=false
for attempt in {1..100}; do
  kill -0 "${pids[0]}"
  if xdpyinfo >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.1
done
[ "$ready" = true ]
python3 /opt/lh/screen/dress.py
touch "$HOME/.vnc/desk-ready"
rsvg-convert -w "$3" -h "$4" "$HOME/wallpaper.svg" -o "$HOME/.vnc/wallpaper.png"
openbox --config-file /opt/lh/screen/openbox.xml & pids+=("$!")
tint2 -c "$HOME/.vnc/tint2rc" & pids+=("$!")
feh --bg-fill "$HOME/.vnc/wallpaper.png"
wait "${pids[0]}"

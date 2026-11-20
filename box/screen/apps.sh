#!/bin/bash
# Run as root. The package source is the one already set up in this Linux space.
set -euo pipefail
[ "$(id -u)" = 0 ]
[[ $# == 0 ]] || exit 2
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends pcmanfm mousepad libreoffice-writer \
  libreoffice-calc libreoffice-impress xpdf ristretto xfce4-terminal
install -d -m 755 /opt/lh/screen
# Keep this list in one place. Add one row here to offer another installed program.
cat > /opt/lh/screen/apps.json.tmp <<'JSON'
[
  {"id":"browser","name":"Browser","command":["/opt/lh/screen/open-browser.sh"],"icon":"web-browser"},
  {"id":"files","name":"Files","command":["/usr/bin/pcmanfm"],"icon":"system-file-manager"},
  {"id":"text","name":"Text editor","command":["/usr/bin/mousepad"],"icon":"accessories-text-editor"},
  {"id":"documents","name":"Documents","command":["/usr/bin/libreoffice","--writer"],"icon":"x-office-document"},
  {"id":"sheets","name":"Spreadsheets","command":["/usr/bin/libreoffice","--calc"],"icon":"x-office-spreadsheet"},
  {"id":"slides","name":"Slides","command":["/usr/bin/libreoffice","--impress"],"icon":"x-office-presentation"},
  {"id":"pdf","name":"PDF reader","command":["/usr/bin/xpdf"],"icon":"application-pdf"},
  {"id":"pictures","name":"Pictures","command":["/usr/bin/ristretto"],"icon":"image-x-generic"},
  {"id":"terminal","name":"Terminal","command":["/usr/bin/xfce4-terminal","--disable-server"],"icon":"utilities-terminal"}
]
JSON
chmod 644 /opt/lh/screen/apps.json.tmp
mv -f /opt/lh/screen/apps.json.tmp /opt/lh/screen/apps.json
dpkg-query -W -f='${Package}\t${Installed-Size}\n' pcmanfm mousepad 'libreoffice*' xpdf ristretto xfce4-terminal \
  > /opt/lh/screen/apps-size.txt
echo 'The programs are ready. Reopen each computer to refresh its bar.'

#!/usr/bin/python3
"""Prepare this user's home tab, launchers and quiet window colours."""
import json
import os
from pathlib import Path
import pwd
import re
import stat
from programs import read_apps

ROOT = Path('/opt/lh/screen')
EXTENSION_ID = 'edckcealbnlgipblljdilomlmgphefii'


def folder(path):
    # Every part is checked, including parents which may already exist.
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            pass
        if not stat.S_ISDIR(current.lstat().st_mode):
            raise ValueError('A computer folder is not a plain folder.')


def write(path, text):
    folder(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as target:
        target.write(text)


def main():
    account = pwd.getpwuid(os.getuid())
    assert os.getuid() != 0 and re.fullmatch(r'bot-[a-z0-9][a-z0-9-]{0,24}', account.pw_name)
    home = Path(account.pw_dir)
    assert Path(os.environ['HOME']) == home
    # No bot text is used as a file name or a command.
    page = (home / 'home.html').read_text()
    wall = (home / 'wallpaper.svg').read_text()
    match = re.search(r'<metadata id="desk-palette">(#[0-9A-Fa-f]{6})\|(light|dark)</metadata>', wall)
    accent, mode = match.groups() if match else ('#2F68DA', 'light')
    dark = mode == 'dark'
    extension = home / '.local/share/tavi-home'
    write(extension / 'manifest.json', (ROOT / 'extension.json').read_text())
    # The extension allows only its own script files, never a page's inline code.
    scripts = re.findall(r'<script>(.*?)</script>', page, re.S)
    assert len(scripts) == 1
    settings = re.search(r'<script id="desk-settings" type="application/json">(.*?)</script>', page, re.S)
    assert settings
    data = json.loads(settings.group(1))
    script = scripts[0].replace("JSON.parse(document.getElementById('desk-settings').textContent)", json.dumps(data).replace('<', '\\u003c'))
    page = re.sub(r'<script id="desk-settings" type="application/json">.*?</script>', '', page, flags=re.S)
    page = re.sub(r'<script>.*?</script>', '<script src="home.js"></script>', page, flags=re.S)
    write(extension / 'home.html', page)
    write(extension / 'home.js', script)
    host = json.dumps(dict(name='app.tavi.desk', description="Open this computer's programs", path=str(ROOT / 'native.py'), type='stdio', allowed_origins=['chrome-extension://' + EXTENSION_ID + '/']))
    # Chromium's per-user host location. Chrome also accepts its own product folder.
    for browser in ('chromium', 'google-chrome', 'google-chrome-for-testing'):
        write(home / '.config' / browser / 'NativeMessagingHosts/app.tavi.desk.json', host)
    write(home / 'chrome-profile/NativeMessagingHosts/app.tavi.desk.json', host)
    apps = read_apps()
    write(home / '.local/share/tavi-computer.txt', "Your home folder is your own. Your files, downloads and browser sign-ins stay on this computer.\nPrograms on this computer: " + ', '.join(a['name'] for a in apps) + '.\nRead /opt/lh/screen/apps.json for their opening commands; if it is missing, use the browser and xterm.\n')
    launchers = []
    for app in apps:
        path = home / '.local/share/tavi-launchers' / (app['id'] + '.desktop')
        # Only the fixed helper and a checked id go into a desktop command.
        write(path, '[Desktop Entry]\nType=Application\nName=' + app['name'] + '\nIcon=' + app['icon'] + '\nExec=/usr/bin/python3 /opt/lh/screen/launch.py ' + app['id'] + '\nTerminal=false\n')
        launchers.append('launcher_item_app = ' + str(path))
    panel = (ROOT / 'tint2rc').read_text().replace('__ACCENT__', accent).replace('__PANEL__', '#252B3A' if dark else '#F8FAFE').replace('__INK__', '#E9EDF5' if dark else '#34435A')
    write(home / '.vnc/tint2rc', panel + '\n' + '\n'.join(launchers) + '\n')
    theme = home / '.themes/Tavi/openbox-3'
    background, ink = ('#252B3A', '#E9EDF5') if dark else ('#F5F8FD', '#34435A')
    write(theme / 'themerc', f'window.active.title.bg: Flat Solid\nwindow.active.title.bg.color: {background}\nwindow.inactive.title.bg: Flat Solid\nwindow.inactive.title.bg.color: {background}\nwindow.active.label.bg: Parentrelative\nwindow.active.label.text.color: {ink}\nwindow.inactive.label.text.color: {ink}\nwindow.active.button.*.bg: Parentrelative\nwindow.active.button.*.image.color: {ink}\nwindow.inactive.button.*.bg: Parentrelative\nwindow.inactive.button.*.image.color: {ink}\nwindow.active.border.color: {accent}\nwindow.inactive.border.color: {background}\nborder.width: 1\npadding.width: 10\npadding.height: 7\nwindow.handle.width: 0\nwindow.client.padding.width: 0\nwindow.label.text.justify: left\n')


if __name__ == '__main__':
    main()

#!/usr/bin/python3
"""One list for the home page, the bar and the bot's own program notes."""
import json
import base64
import os
from pathlib import Path
import re
import stat
import subprocess

BASICS = [
    dict(id='browser', name='Browser', command=['/opt/lh/screen/open-browser.sh'], icon='web-browser'),
    dict(id='terminal', name='Terminal', command=['/usr/bin/xterm'], icon='utilities-terminal'),
]


def read_apps(filename='/opt/lh/screen/apps.json'):
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as source:
            info = os.fstat(source.fileno())
            if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISREG(info.st_mode) or info.st_size > 32768:
                return BASICS
            apps = json.load(source)
        if not isinstance(apps, list) or not 1 <= len(apps) <= 24:
            return BASICS
        ids = set()
        for app in apps:
            if not isinstance(app, dict) or not isinstance(app.get('id'), str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', app['id']) or app['id'] in ids:
                return BASICS
            if not isinstance(app.get('name'), str) or not app['name'].strip() or len(app['name']) > 60 or any(ord(c) < 32 for c in app['name']):
                return BASICS
            if not isinstance(app.get('icon'), str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', app['icon']):
                return BASICS
            command = app.get('command')
            if not isinstance(command, list) or not 1 <= len(command) <= 8 or any(not isinstance(arg, str) or len(arg) > 256 or any(ord(c) < 32 for c in arg) for arg in command):
                return BASICS
            if not re.fullmatch(r'/usr/bin/[a-zA-Z0-9._+-]+', command[0]) and command[0] != '/opt/lh/screen/open-browser.sh':
                return BASICS
            if not os.access(command[0], os.X_OK):
                return BASICS
            ids.add(app['id'])
        return apps
    except (OSError, ValueError, TypeError):
        return BASICS


def system_picture(icon):
    for theme in ('Adwaita', 'hicolor'):
        for section in ('apps', 'mimetypes', 'places'):
            for size, name, kind in [('scalable', icon + '-symbolic.svg', 'svg+xml'), ('scalable', icon + '.svg', 'svg+xml'), ('48x48', icon + '.png', 'png')]:
                path = Path('/usr/share/icons') / theme / size / section / name
                try:
                    if path.stat().st_size > 32768:
                        continue
                    return 'data:image/' + kind + ';base64,' + base64.b64encode(path.read_bytes()).decode()
                except OSError:
                    pass
    return None


def public_apps(apps):
    return [dict({key: app[key] for key in ('id', 'name', 'icon')}, picture=system_picture(app['icon'])) for app in apps]


def answer(message, apps=None, launch=subprocess.Popen):
    apps = read_apps() if apps is None else apps
    if not isinstance(message, dict):
        return dict(ok=False, error='That program request is not valid.')
    if message == dict(action='list'):
        return dict(ok=True, apps=public_apps(apps))
    if set(message) != {'action', 'id'} or message['action'] != 'open' or not isinstance(message['id'], str):
        return dict(ok=False, error='Choose a program on this computer.')
    app = next((a for a in apps if a['id'] == message['id']), None)
    if app is None:
        return dict(ok=False, error='That program is not on this computer.')
    try:
        launch(app['command'], cwd=os.path.expanduser('~'), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        return dict(ok=True)
    except OSError:
        return dict(ok=False, error='That program could not open. Try reopening the computer.')

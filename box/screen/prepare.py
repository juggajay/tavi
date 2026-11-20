#!/usr/bin/python3
# The guard sends the picture, page and screen access key through the open pipe.
import json
import os
import pwd
import re
import subprocess
import sys

user = sys.argv[1]
assert os.getuid() == 0 and re.fullmatch(r'bot-[a-z0-9][a-z0-9-]{0,24}', user)
settings = json.load(sys.stdin)
assert re.fullmatch(r'[A-Za-z0-9+/]{8}', settings['password'])
subprocess.run(['runuser', '-u', 'lh-team', '--', 'bash', '/opt/lh/screen/make-key.sh', user[4:]], check=True, stdout=subprocess.DEVNULL)
# This folder belongs to root. A bot cannot replace its own allowed key or add one.
with open('/srv/lh/team/keys/' + user[4:] + '.pub', 'r') as source:
    public_key = source.read().strip()
assert re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?', public_key)
os.makedirs('/etc/lh/keys', mode=0o755, exist_ok=True)
with open('/etc/lh/keys/' + user, 'w') as target:
    target.write('restrict ' + public_key + '\n')
os.chmod('/etc/lh/keys/' + user, 0o644)
account = pwd.getpwnam(user)
# Never write inside a bot's home as root. It may have moved files or left links there.
os.initgroups(user, account.pw_gid)
os.setgid(account.pw_gid)
os.setuid(account.pw_uid)
os.environ['HOME'] = account.pw_dir
os.umask(0o077)
os.chdir(account.pw_dir)
os.makedirs('.vnc', mode=0o700, exist_ok=True)
for name, value in [('wallpaper.svg', settings['wallpaper']), ('home.html', settings['home'])]:
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as target:
        target.write(value)
fd = os.open('.vnc/passwd', os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'wb') as target:
    subprocess.run(['vncpasswd', '-f'], input=(settings['password'] + '\n').encode(), stdout=target, stderr=subprocess.DEVNULL, check=True)
os.chmod('.vnc/passwd', 0o600)

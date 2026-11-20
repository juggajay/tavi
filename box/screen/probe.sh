#!/bin/bash
# Root sets up real listeners. The checks themselves run as an ordinary bot.
# One helper program per user tries every port in a single run: starting a program per attempt
# took 16 seconds for one bot on the real space and ran past the guard's time limit with two.
set -euo pipefail
exec python3 - <<'PY'
import json, os, pwd, socket, subprocess

assert os.getuid() == 0
rows = []
with open('/var/lib/lh-screen/ports') as source:
    for row in source:
        if row.strip(): rows.append(row.split())

BATCH = '''
import json, socket, sys
reached = []
for target in sys.argv[1:]:
    host, port = target.rsplit("|", 1)
    try:
        s = socket.create_connection((host, int(port)), 0.25); s.close(); reached.append(target)   # loopback: a quarter second is ample; refused IPv6 attempts wait the full time
    except OSError:
        pass
print(json.dumps(reached))
'''

def reached_by(user, targets):
    """Which of the targets this user can connect to. None when the helper itself failed."""
    done = subprocess.run(['runuser', '-u', user, '--', 'python3', '-c', BATCH, *targets],
                          capture_output=True, text=True, timeout=60)
    if done.returncode != 0: return None
    return set(json.loads(done.stdout or '[]'))

def command(user, script, *args):
    return subprocess.run(['runuser', '-u', user, '--', 'python3', '-c', script, *map(str, args)],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode

listeners = []
try:
    ports = sorted(set([5999, 8650, 8749, 9309, 2222] + [int(p) for row in rows for p in row[1:]]))
    targets = []
    for host in ['127.0.0.1', '::1']:
        family = socket.AF_INET if host == '127.0.0.1' else socket.AF_INET6
        for port in ports:
            try:
                listener = socket.socket(family)
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                if family == socket.AF_INET6: listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                listener.bind((host, port)); listener.listen(128); listeners.append(listener)
            except OSError:
                listener.close()   # something real is already listening there, which serves the same purpose
            # A successful root connection proves each refusal below is a fence, not a missing service.
            with socket.create_connection((host, port), 1): pass
            targets.append(f'{host}|{port}')

    for user in ['bot-probe'] + [r[0] for r in rows]:
        own_screen = next((int(r[1]) for r in rows if r[0] == user), None)
        got = reached_by(user, targets)
        assert got is not None, 'The check could not run as a bot.'
        allowed = {t for t in targets if own_screen is not None and int(t.rsplit('|', 1)[1]) == own_screen}
        assert got <= allowed, 'A bot reached a closed port.'

    browser_controls = {f'127.0.0.1|{int(r[2])}' for r in rows}
    if browser_controls:
        got = reached_by('lh-team', sorted(browser_controls))
        assert got is not None and got == browser_controls, 'The engine cannot reach a browser.'

    for user, _, _ in rows:
        home = pwd.getpwnam(user).pw_dir
        for other in ['bot-probe'] + [r[0] for r in rows if r[0] != user]:
            assert command(other, 'import os,sys; os.listdir(sys.argv[1])', home) != 0, 'A bot read another home.'
        assert command(user, 'import os; os.listdir("/srv/lh/team")') != 0, 'A bot read the sign-ins.'
        assert command(user, 'import os,sys; assert os.access(sys.argv[1], os.W_OK)', '/etc/lh/keys') != 0, 'A bot can change the allowed keys.'
    print('ok    bots cannot reach other screens, browser controls, the engine or ssh')
    print('ok    unused ports are closed in both address families')
    print('ok    the engine can reach browser controls')
    print('ok    bot homes, sign-ins and allowed keys are kept apart')
finally:
    for listener in listeners: listener.close()
PY

#!/usr/bin/python3
"""Chrome starts this pipe as the bot's own user. There is no listening port."""
import json
import os
import pwd
import re
import struct
import sys
from programs import answer

ORIGIN = 'chrome-extension://edckcealbnlgipblljdilomlmgphefii/'


def main():
    if os.getuid() == 0 or not re.fullmatch(r'bot-[a-z0-9][a-z0-9-]{0,24}', pwd.getpwuid(os.getuid()).pw_name):
        return
    if len(sys.argv) != 2 or sys.argv[1] != ORIGIN or not re.fullmatch(r':[1-9][0-9]?', os.environ.get('DISPLAY', '')):
        return
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        return
    size = struct.unpack('=I', header)[0]
    if not 1 <= size <= 1024:
        return
    try:
        raw = sys.stdin.buffer.read(size)
        if len(raw) != size:
            return
        response = answer(json.loads(raw))
    except (ValueError, TypeError):
        response = dict(ok=False, error='That program request is not valid.')
    raw = json.dumps(response).encode()
    sys.stdout.buffer.write(struct.pack('=I', len(raw)) + raw)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()

#!/usr/bin/python3
import os
import pwd
import re
import sys
from programs import answer

if __name__ == '__main__':
    assert os.getuid() != 0 and re.fullmatch(r'bot-[a-z0-9][a-z0-9-]{0,24}', pwd.getpwuid(os.getuid()).pw_name)
    assert len(sys.argv) == 2 and re.fullmatch(r':[1-9][0-9]?', os.environ.get('DISPLAY', ''))
    sys.exit(0 if answer(dict(action='open', id=sys.argv[1]))['ok'] else 1)

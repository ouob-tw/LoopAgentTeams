"""Stand-in for `hcom` in the vm tests.

`list --json` prints FAKE_HCOM_LIST (exit 1 when that file is missing); `send` is
appended to FAKE_EVENTS."""
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
if args[:1] == ['list']:
    path = Path(os.environ['FAKE_HCOM_LIST'])
    if not path.exists():
        print('hcom: database unavailable', file=sys.stderr)
        sys.exit(1)
    print(path.read_text())
elif args[:1] == ['send']:
    # vm.py sends exactly: send @<name> --from vm --intent inform -- <text>
    if (len(args) != 8 or not args[1].startswith('@') or len(args[1]) < 2
            or args[2:7] != ['--from', 'vm', '--intent', 'inform', '--'] or not args[7].strip()):
        print(f'hcom send: invalid arguments {args}', file=sys.stderr)
        sys.exit(2)
    names = {a['name'] for a in json.loads(Path(os.environ['FAKE_HCOM_LIST']).read_text())} \
        if Path(os.environ['FAKE_HCOM_LIST']).exists() else set()
    if args[1][1:] not in names:
        print(f'hcom send: no agent matches {args[1]}', file=sys.stderr)
        sys.exit(1)
    with open(os.environ['FAKE_EVENTS'], 'a') as events:
        events.write(json.dumps(['hcom', *args]) + '\n')
else:
    sys.exit(2)

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
    with open(os.environ['FAKE_EVENTS'], 'a') as events:
        events.write(json.dumps(['hcom', *args]) + '\n')
else:
    sys.exit(2)

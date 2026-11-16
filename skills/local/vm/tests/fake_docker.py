"""Stand-in for `docker` in the vm tests: inspect/start/stop on a JSON state file.

FAKE_DOCKER_STATE holds {"containers": {name: {"running": bool}}, "fail_start": [...],
"fail_stop": [...], "start_delay": seconds}. Every call is appended to FAKE_EVENTS."""
import fcntl
import json
import os
import sys
import time
from pathlib import Path

state_path = Path(os.environ['FAKE_DOCKER_STATE'])
args = sys.argv[1:]
with open(state_path.with_suffix('.lock'), 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    state = json.loads(state_path.read_text())
    with open(os.environ['FAKE_EVENTS'], 'a') as events:
        events.write(json.dumps(['docker', *args]) + '\n')
# Only the exact call shapes vm.py may use; anything else fails like a wrong docker call.
shapes = {'inspect': ['inspect', '-f', '{{.State.Running}}'], 'start': ['start'],
          'stop': ['stop', '-t', '120']}
if len(args) < 2 or args[0] not in shapes or args[:-1] != shapes[args[0]]:
    print(f'fake docker: unexpected call {args}', file=sys.stderr)
    sys.exit(125)
container = args[-1]
known = state['containers'].get(container)
if known is None:
    print(f'Error: No such object: {container}', file=sys.stderr)
    sys.exit(1)
if args[0] == 'inspect':
    print('true' if known['running'] else 'false')
    sys.exit(0)
if args[0] == 'start':
    time.sleep(state.get('start_delay', 0))
    if container in state.get('fail_start', []):
        print(f'Error response from daemon: cannot start {container}', file=sys.stderr)
        sys.exit(1)
    running = True
elif args[0] == 'stop':
    if container in state.get('fail_stop', []):
        print(f'Error response from daemon: cannot stop {container}', file=sys.stderr)
        sys.exit(1)
    running = False
with open(state_path.with_suffix('.lock'), 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    state = json.loads(state_path.read_text())
    state['containers'][container]['running'] = running
    state_path.write_text(json.dumps(state))
print(container)

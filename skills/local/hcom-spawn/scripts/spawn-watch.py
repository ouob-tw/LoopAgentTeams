#!/usr/bin/env python3
"""Background check started by spawn-guard.py for one `hcom N claude|codex` launch.

Finds the launch batch, subscribes the spawner to each new agent's approval-blocked status,
compares model, effort and permission on the agent's screen with the launch command, tells
the spawner about any mismatch or anything it could not confirm, and removes the
subscriptions once the agents stop.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

NAME = re.compile(r'^[A-Za-z0-9_-]+$')
SENDER = 'hcom-spawn'
BATCH_WAIT = 90        # seconds to wait for the launch to show up in hcom events
SCREEN_WINDOW = 20     # seconds of screen reading after the agent is ready
DEADLINE = 180         # seconds after the launch to give up on confirming
POLL = 0.3
STOP_POLL = 5
ITEMS = ('model', 'effort', 'permission')
EXPECTED_PERMISSION = {'claude': 'bypass permissions on', 'codex': 'YOLO'}
EFFORTS = 'none|minimal|low|medium|high|xhigh|max'
CLAUDE_BANNER = re.compile(r'\b([A-Z][a-z]+ \d+(?:\.\d+)?) with (\w+) effort')
CLAUDE_EFFORT = re.compile(rf'\b({EFFORTS}) · /effort')
CLAUDE_MODES = re.compile(r'(bypass permissions on|auto mode on|accept edits on|plan mode on)')
CODEX_STATUS = re.compile(rf'^\s*(\S+) ({EFFORTS}) · ')
CODEX_BANNER = re.compile(rf'model:\s+(\S+)\s+({EFFORTS})\b')
CODEX_PERMISSION = re.compile(r'permissions:\s+(.+?)\s*(?:│|$)')

clock, sleep = time.monotonic, time.sleep


def hcom(*args, timeout=30):
    """Run hcom; return (exit code, stdout). Identity comes from the explicit flags only."""
    env = {k: v for k, v in os.environ.items()
           if k not in ('HCOM_INSTANCE_NAME', 'HCOM_PROCESS_ID')}
    try:
        done = subprocess.run(['hcom', *args], capture_output=True, text=True,
                              timeout=timeout, env=env)
    except (OSError, subprocess.SubprocessError) as error:
        return 1, str(error)
    return done.returncode, done.stdout


def events(*filters):
    _, out = hcom('events', '--last', '50', *filters)
    found = []
    for line in out.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and 'id' in event:
            found.append(event)
    return found


def state_dir():
    base = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state'))
    path = base / 'hcom-spawn'
    (path / 'subs').mkdir(parents=True, exist_ok=True)
    return path


def next_run(spawner, after_id):
    """after_id of the spawner's next guarded command; its batches are not ours."""
    try:
        later = [int(run) for run in (state_dir() / 'runs' / spawner).read_text().split()
                 if run.isdigit() and int(run) > after_id]
    except OSError:
        later = []
    return min(later, default=None)


def find_batch(spawner, tool, tag, after_id, ordinal):
    """The ordinal-th batch with this tool (and tag, when given) that this spawner's
    command launched.

    Batches after after_id, up to and including the event id the spawner's next guarded
    command started from, belong to this command, in launch order. hcom records the spawner by base name, so
    `--name <tag>-<base>` matches `by: <base>`.
    """
    start = clock()
    while clock() - start < BATCH_WAIT:
        upper = next_run(spawner, after_id)
        mine = [event for event in events(
                    '--type', 'life', '--action', 'batch_launched',
                    '--sql', f"id > {after_id} AND (life_by = '{spawner}' "
                             f"OR '{spawner}' LIKE '%-' || life_by)")
                if event.get('data', {}).get('tool') == tool
                and (not tag or event['data'].get('tag') == tag)
                and (upper is None or event['id'] <= upper)]
        mine.sort(key=lambda event: event['id'])
        if len(mine) > ordinal:
            return mine[ordinal] if mine[ordinal]['data'].get('instances') else None
        if upper is not None:
            return None
        sleep(POLL)
    return None


def stopped_since(name, after_id):
    return bool(events('--type', 'life', '--action', 'stopped', '--agent', name,
                       '--sql', f'id > {after_id}'))


def subscribe(name, spawner, launch_id):
    code, out = hcom('events', 'sub', '--blocked', name, '--for', spawner)
    match = re.search(r'\b(sub-[0-9a-f]+)\b', out)
    if code or not match:
        return None
    sub = match.group(1)
    record = {'sub': sub, 'agent': name, 'spawner': spawner, 'launch_id': launch_id}
    (state_dir() / 'subs' / f'{sub}.json').write_text(json.dumps(record))
    return sub


def unsubscribe(sub):
    """Remove the subscription; keep its record for the next sweep if hcom still has it."""
    code, _ = hcom('events', 'unsub', sub)
    if code:
        _, listed = hcom('events', 'sub', 'list')
        if re.search(rf'^{re.escape(sub)}\s', listed, re.M):
            return
    (state_dir() / 'subs' / f'{sub}.json').unlink(missing_ok=True)


def sweep():
    """Remove subscriptions left by a watcher that died before its agents stopped."""
    for path in (state_dir() / 'subs').glob('*.json'):
        try:
            record = json.loads(path.read_text())
            agent, launch_id, sub = record['agent'], int(record['launch_id']), record['sub']
        except FileNotFoundError:  # another watcher removed it meanwhile
            continue
        except (OSError, ValueError, KeyError, TypeError):
            path.unlink(missing_ok=True)
            continue
        if NAME.match(str(agent)) and stopped_since(agent, launch_id):
            unsubscribe(sub)


def norm_model(text):
    text = re.sub(r'\[.*?\]', '', text.lower().strip())
    return re.sub(r'[\s._]+', '-', re.sub(r'^claude-', '', text))


def read_screen(tool, lines, seen):
    """Record model, effort and permission shown on one screen; first value seen wins."""
    def note(item, value):
        seen.setdefault(item, (value, 'screen'))

    for line in lines:
        if tool == 'claude':
            if match := CLAUDE_BANNER.search(line):
                note('model', match.group(1))
                note('effort', match.group(2))
            if match := CLAUDE_EFFORT.search(line):
                note('effort', match.group(1))
            if match := CLAUDE_MODES.search(line):
                note('permission', match.group(1))
        else:
            if match := CODEX_STATUS.search(line) or CODEX_BANNER.search(line):
                note('model', match.group(1))
                note('effort', match.group(2))
            if match := CODEX_PERMISSION.search(line):
                note('permission', match.group(1))


def read_session_log(tool, path, seen):
    """Fill items the screen did not show from the agent's session log."""
    found = {}
    try:
        with open(path) as log:
            for line in log:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if tool == 'claude':
                    if entry.get('type') == 'permission-mode' and entry.get('permissionMode'):
                        found['permission'] = entry['permissionMode']
                    if entry.get('type') == 'assistant':
                        found['model'] = entry.get('message', {}).get('model') or found.get('model')
                        found['effort'] = entry.get('effort') or found.get('effort')
                elif entry.get('type') == 'turn_context':
                    payload = entry.get('payload', {})
                    approval = payload.get('approval_policy')
                    sandbox = (payload.get('sandbox_policy') or {}).get('type')
                    found['model'] = payload.get('model')
                    found['effort'] = payload.get('effort')
                    found['permission'] = ('YOLO' if (approval, sandbox) == ('never', 'danger-full-access')
                                           else f'approval {approval}, sandbox {sandbox}')
    except OSError:
        return
    for item, value in found.items():
        if value:
            seen.setdefault(item, (value, 'session log'))


def matches(tool, item, expected, actual):
    if item == 'model':
        return norm_model(actual) == norm_model(expected)
    if item == 'effort':
        return actual.lower() == expected.lower()
    if tool == 'claude':
        return actual in ('bypass permissions on', 'bypassPermissions')
    return 'YOLO' in actual


def report(tool, full, expected, seen, reason):
    """Message text for the spawner, or None when everything matched."""
    problems = []
    for item in ITEMS:
        if item not in seen:
            problems.append(f'{item}: expected {expected[item]}, could not confirm ({reason})')
        elif not matches(tool, item, expected[item], seen[item][0]):
            value, source = seen[item]
            problems.append(f'{item}: expected {expected[item]}, {source} shows {value}')
    if not problems:
        return None
    return (f'hcom-spawn launch check: {full} ({tool}) does not match its launch command. '
            + '; '.join(problems)
            + f'. Look at it with `hcom term {full}`; it was not stopped.')


def release_stopped(subs, launch_id):
    """Unsubscribe agents that stopped since the launch; return their names."""
    stopped = [name for name in subs if stopped_since(name, launch_id)]
    for name in stopped:
        if subs[name]:
            unsubscribe(subs[name])
        del subs[name]
    return stopped


def check(tool, agents, expected, subs, launch_id, start):
    """Read screens (then session logs) until every item is known or time runs out.

    Agents that stop meanwhile are released and get no report.
    """
    seen = {name: {} for name in agents}
    reasons = {name: 'agent did not become ready' for name in agents}
    ready_at, logs, pending = {}, {}, set(agents)
    while pending and clock() - start < DEADLINE:
        pending -= set(release_stopped(subs, launch_id))
        for name in sorted(pending):
            full = agents[name]
            code, out = hcom('term', full, '--json', timeout=10)
            try:
                screen = json.loads(out) if code == 0 else None
            except ValueError:
                screen = None
            if screen:
                read_screen(tool, [str(line) for line in screen.get('lines', [])], seen[name])
                if screen.get('ready'):
                    ready_at.setdefault(name, clock())
                    reasons[name] = 'not shown on the screen or in the session log'
            elif name not in ready_at:
                reasons[name] = 'screen could not be read: ' + (out.strip() or 'no output')[:120]
            if name in ready_at and clock() - ready_at[name] > SCREEN_WINDOW:
                if name not in logs:
                    _, listed = hcom('list', full, '--json')
                    try:
                        logs[name] = json.loads(listed).get('transcript_path') or ''
                    except (ValueError, AttributeError):
                        logs[name] = ''
                if logs[name]:
                    read_session_log(tool, logs[name], seen[name])
            if all(item in seen[name] for item in ITEMS):
                pending.discard(name)
        sleep(POLL)
    release_stopped(subs, launch_id)
    return {name: report(tool, agents[name], expected, seen[name],
                         f'{reasons[name]} within {DEADLINE}s') for name in agents if name in subs}


def notify(spawner, text):
    hcom('send', f'@{spawner}', '--intent', 'inform', '--from', SENDER, '--', text)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--spawner', required=True)
    parser.add_argument('--tool', required=True, choices=sorted(EXPECTED_PERMISSION))
    parser.add_argument('--model', required=True)
    parser.add_argument('--effort', required=True)
    parser.add_argument('--after-id', required=True, type=int)
    parser.add_argument('--ordinal', type=int, default=0)
    parser.add_argument('--tag', default='')
    args = parser.parse_args(argv)
    if not NAME.match(args.spawner):
        return 1
    sweep()
    batch = find_batch(args.spawner, args.tool, args.tag, args.after_id, args.ordinal)
    if not batch:
        return 0
    start = clock()
    data, launch_id = batch['data'], batch['id']
    spawner = data.get('by') or args.spawner
    names = [name for name in data['instances'] if NAME.match(name)]
    agents = {name: f"{data['tag']}-{name}" if data.get('tag') else name for name in names}
    subs = {name: subscribe(name, spawner, launch_id) for name in names}
    release_stopped(subs, launch_id)
    for name in subs:
        if events('--type', 'status', '--status', 'blocked', '--agent', name,
                  '--sql', f'id > {launch_id}'):
            notify(spawner, f'{agents[name]} is waiting for approval (blocked); '
                                 f'look at it with `hcom term {agents[name]}`.')
    expected = {'model': args.model, 'effort': args.effort,
                'permission': EXPECTED_PERMISSION[args.tool]}
    for text in check(args.tool, agents, expected, subs, launch_id, start).values():
        if text:
            notify(spawner, text)
    while subs:
        sleep(STOP_POLL)
        release_stopped(subs, launch_id)
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Close hcom agents by name and check that each one is really gone.

For each agent: read its Herdr pane from `hcom list --json` (launch_context.pane_id), run
`hcom kill`, fall back to `hcom stop` when hcom has no tracked PID (agents hcom did not
launch itself, e.g. from the board), close the pane when it is still open, then check that
the name left `hcom list` and the pane left Herdr. A pane is closed only when it is tied to
the agent: hcom recorded it for that agent, Herdr still has it, and no other listed agent
and not the caller sits in it. Prints one line per agent and exits 1 when anything is left.

Usage: close-agent.py --name <caller> <agent>... | tag:<tag>
"""
import argparse
import json
import subprocess
import sys
import time

VERIFY_WAIT = 10   # seconds to wait for the name and pane to disappear
POLL = 0.5

clock, sleep = time.monotonic, time.sleep


def run(command, timeout=30):
    """Run a command; return (exit code, stdout + stderr)."""
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as error:
        return 1, str(error)
    return done.returncode, done.stdout + done.stderr


def hcom(*args):
    return run(['hcom', *args])


def herdr(*args):
    return run(['herdr', *args], timeout=10)


def listed(caller):
    """Return the `hcom list --json` rows by name, or None when hcom cannot be read."""
    code, out = hcom('list', '--json', '--name', caller)
    try:
        return {row['name']: row for row in json.loads(out)} if code == 0 else None
    except (ValueError, KeyError, TypeError):
        return None


def pane_of(row):
    return ((row or {}).get('launch_context') or {}).get('pane_id')


def pane_open(pane):
    """True when Herdr has the pane, False when it reports pane_not_found, None otherwise."""
    code, out = herdr('pane', 'get', pane)
    if code == 0:
        return True
    return False if 'pane_not_found' in out else None


def tie(name, rows, caller):
    """Return (pane, reason): the pane to close, or None and why it is not tied."""
    pane = pane_of(rows[name])
    if not pane:
        return None, 'no Herdr pane recorded in hcom list'
    sharers = sorted(other for other, row in rows.items() if other != name and pane_of(row) == pane)
    if caller in sharers:
        return None, f'pane {pane} is the caller\'s own pane'
    if sharers:
        return None, f"pane {pane} is also recorded for {', '.join(sharers)}"
    return pane, None


def kill(name, caller):
    """Return ('killed' | 'no-pid' | 'failed', hcom output)."""
    code, out = hcom('kill', name, '--json', '--name', caller)
    if code == 0:
        return 'killed', out
    return ('no-pid' if 'No tracked PID' in out else 'failed'), out


def close(name, rows, caller):
    """Close one agent; return (ok, report line)."""
    pane, untied = tie(name, rows, caller)
    if untied and pane_of(rows[name]):
        # hcom kill closes the recorded pane itself, so an untied pane stops the whole close.
        return False, f'{name}: not closed: {untied}'
    how, out = kill(name, caller)
    if how == 'no-pid':
        code, out = hcom('stop', name, '--name', caller)
        how = 'stopped' if code == 0 else 'failed'
    if how == 'failed':
        return False, f'{name}: not closed: {out.strip()[:300]}'
    if pane and pane_open(pane):
        code, out = herdr('pane', 'close', pane)
        if code:
            return False, f'{name}: {how}, but herdr pane close {pane} failed: {out.strip()[:200]}'

    end = clock() + VERIFY_WAIT
    while True:
        rows_now = listed(caller)
        name_left = rows_now is None or name in rows_now
        pane_left = pane is not None and pane_open(pane) is not False
        if not (name_left or pane_left) or clock() >= end:
            break
        sleep(POLL)
    left = []
    if name_left:
        left.append('name still in hcom list' if rows_now is not None else 'hcom list unreadable')
    if pane_left:
        left.append(f'pane {pane} still open')
    if untied:
        left.append(f'pane not checked: {untied}')
    if left:
        return False, f"{name}: {how}; left: {'; '.join(left)}"
    return True, f'{name}: {how}; name gone from hcom list; pane {pane} gone from Herdr'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--name', required=True, help="the caller's hcom name")
    parser.add_argument('agents', nargs='+', help='agent names, or tag:<tag> for a whole tag')
    args = parser.parse_args(argv)

    rows = listed(args.name)
    if rows is None:
        print('close-agent: cannot read hcom list --json', file=sys.stderr)
        return 1
    names = []
    for target in args.agents:
        if target.startswith('tag:'):
            names += sorted(n for n, row in rows.items() if row.get('tag') == target[4:])
        else:
            names.append(target)
    if not names:
        print(f"close-agent: no listed agent matches {' '.join(args.agents)}", file=sys.stderr)
        return 1

    failed = False
    for name in names:
        if name not in rows:
            ok, line = False, f'{name}: not closed: not in hcom list'
        else:
            ok, line = close(name, rows, args.name)
        print(line)
        failed |= not ok
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())

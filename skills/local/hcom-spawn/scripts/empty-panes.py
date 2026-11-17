#!/usr/bin/env python3
"""List, and with --close close, Herdr panes where nothing runs any more.

Only two kinds count as empty, and only when the pane's one foreground process is a shell
waiting idle at its prompt (spawn-watch.py idle_shell):
- hcom: hcom opened the pane for an agent that is gone. Its shell is the leftover of
  hcom's launch (HCOM_INSTANCE_NAME without HCOM_PROCESS_ID, spawn-watch.py leftover_of).
- deleted: the shell's working folder is deleted (/proc/<pid>/cwd ends in " (deleted)",
  as Herdr shows it).
A pane recorded for an agent in `hcom list`, the caller's own pane (HERDR_PANE_ID) and every
other pane, such as a terminal the user opened whose folder still exists, are never listed
or closed. Pane labels and titles are never read.

Prints one tab-separated line per pane of either kind: pane id, kind, cwd, hcom name (or -),
and "empty" or "kept: <why>". With --close each empty pane is checked again right before
`herdr pane close` (spawn-watch.py guarded_close) and the last field becomes "closed",
"gone" or "kept: <why>". Exits 1 when herdr or hcom cannot be read.

Usage: empty-panes.py [--close]
"""
import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    'spawn_watch', Path(__file__).resolve().parent / 'spawn-watch.py')
watch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(watch)

DELETED = ' (deleted)'


def kind_of(pid):
    """(kind, hcom name) of a pane whose one foreground process is pid, or None. Both are
    read from the process itself, so a re-check sees a `cd` made since the listing."""
    leftover = watch.leftover_of(pid)
    if leftover:
        return 'hcom', leftover[0]
    try:
        if os.readlink(watch.PROC / str(pid) / 'cwd').endswith(DELETED):
            return 'deleted', None
    except OSError:
        pass
    return None


def why_not_empty(pid, kind, name):
    """Why the pane with this foreground process is not (or no longer) empty, or None."""
    if kind_of(pid) != (kind, name):
        return f'process {pid} is no longer the {kind} shell it was'
    return watch.idle_shell(pid)


def candidates(own):
    """Rows (pane, kind, cwd, name, why) of panes of either kind, or None when herdr or hcom
    cannot be read; why is None for an empty pane."""
    code, out = watch.herdr('pane', 'list')
    rows = watch.listing()
    try:
        panes = json.loads(out)['result']['panes'] if code == 0 else None
    except (ValueError, KeyError, TypeError):
        panes = None
    if panes is None or rows is None:
        return None
    recorded = {(row.get('launch_context') or {}).get('pane_id') for row in rows.values()}
    found = []
    for pane in panes:
        pane_id, cwd = pane.get('pane_id'), str(pane.get('cwd') or '')
        if not pane_id or pane_id == own or pane_id in recorded:
            continue
        code, out = watch.herdr('pane', 'process-info', '--pane', pane_id)
        try:
            pids = [int(process['pid']) for process in
                    json.loads(out)['result']['process_info']['foreground_processes']]
        except (ValueError, KeyError, TypeError, AttributeError):
            continue
        if len(pids) != 1 or not (kind := kind_of(pids[0])):
            continue
        found.append((pane_id, kind[0], cwd, kind[1], why_not_empty(pids[0], *kind)))
    return found


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--close', action='store_true',
                        help='close each empty pane after checking it again')
    args = parser.parse_args(argv)
    own = os.environ.get('HERDR_PANE_ID')
    found = candidates(own)
    if found is None:
        print('empty-panes: cannot read herdr pane list or hcom list --json', file=sys.stderr)
        return 1
    for pane, kind, cwd, name, why in found:
        verdict = f'kept: {why}' if why else 'empty'
        if args.close and not why:
            outcome, reason = watch.guarded_close(
                pane, lambda pid: why_not_empty(pid, kind, name))
            verdict = {'closed': 'closed', 'gone': 'gone',
                       'stuck': 'kept: herdr pane close ran but Herdr still shows the pane',
                       'kept': f'kept: {reason}'}[outcome]
        print('\t'.join((pane, kind, cwd, name or '-', verdict)))
    return 0


if __name__ == '__main__':
    sys.exit(main())

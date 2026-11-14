#!/usr/bin/env python3
"""The nightly unattended round's tracker steps (docs/automation/nightly-unattended.md), through gh.

pick       print up to 3 tickets to fix tonight: open, ready-for-agent, without nightly-hold;
           suite-failure first, then bug, then the rest; oldest first within each.
hold N     before working on N: add nightly-hold (created when missing) and say so in a comment.
release N  N was merged into dev: remove nightly-hold.
blocked N  N was parked or failed: keep nightly-hold and comment why, for the user.

Stdlib only; run with `uv run --no-project python scripts/nightly-tickets.py <command>`.
"""
import argparse
from datetime import datetime
import json
import subprocess
import sys
from zoneinfo import ZoneInfo

REPO = 'ouob-tw/LoopAgentTeams-work'
HOLD = 'nightly-hold'
HOLD_COLOR = 'B60205'
HOLD_DESCRIPTION = ('A nightly unattended round is on this, or parked or failed it; '
                    'remove to let it be picked again')
TIERS = {'suite-failure': 0, 'bug': 1}
MAX_PICK = 3


def gh(*args):
    done = subprocess.run(['gh', *args], capture_output=True, text=True)
    if done.returncode != 0:
        sys.exit(f'gh {" ".join(args)} failed: {done.stderr.strip() or done.stdout.strip()}')
    return done.stdout


def label_names(issue):
    return {label['name'] for label in issue.get('labels', [])}


def order(issues, limit=MAX_PICK):
    """The tickets to fix, in the order to fix them."""
    open_ones = [issue for issue in issues if HOLD not in label_names(issue)]

    def key(issue):
        tier = min((TIERS[name] for name in label_names(issue) if name in TIERS), default=2)
        return tier, issue['createdAt'], issue['number']

    return sorted(open_ones, key=key)[:limit]


def ensure_label(repo):
    names = {label['name'] for label in json.loads(gh('label', 'list', '-R', repo, '--json',
                                                      'name', '--limit', '500'))}
    if HOLD not in names:
        gh('label', 'create', HOLD, '-R', repo, '--color', HOLD_COLOR, '--description',
           HOLD_DESCRIPTION)


def cmd_pick(args):
    issues = json.loads(gh('issue', 'list', '-R', args.repo, '-l', 'ready-for-agent', '--state',
                           'open', '--json', 'number,title,labels,createdAt', '--limit', '500'))
    picked = order(issues)
    if args.json:
        print(json.dumps([dict(number=i['number'], title=i['title']) for i in picked],
                         ensure_ascii=False))
    else:
        for issue in picked:
            print(f'#{issue["number"]} {issue["title"]}')


def cmd_hold(args):
    ensure_label(args.repo)
    date = args.date or datetime.now(ZoneInfo('Asia/Taipei')).date().isoformat()
    gh('issue', 'edit', str(args.number), '-R', args.repo, '--add-label', HOLD)
    gh('issue', 'comment', str(args.number), '-R', args.repo, '--body',
       f'Nightly round {date} (Asia/Taipei): working on this. Label `{HOLD}` keeps later '
       'nights from picking it until it is merged or you remove the label.')


def cmd_release(args):
    gh('issue', 'edit', str(args.number), '-R', args.repo, '--remove-label', HOLD)


def cmd_blocked(args):
    ensure_label(args.repo)
    gh('issue', 'edit', str(args.number), '-R', args.repo, '--add-label', HOLD)
    gh('issue', 'comment', str(args.number), '-R', args.repo, '--body',
       f'Nightly round stopped on this: {args.reason}\n\nIt keeps `{HOLD}`, so later nights '
       'skip it; remove the label once you have handled it.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--repo', default=REPO)
    commands = parser.add_subparsers(dest='command', required=True)
    pick = commands.add_parser('pick', help='up to 3 tickets to fix tonight, in order')
    pick.add_argument('--json', action='store_true')
    pick.set_defaults(run=cmd_pick)
    hold = commands.add_parser('hold', help='mark a ticket picked, before working on it')
    hold.add_argument('number', type=int)
    hold.add_argument('--date', help='the round date, YYYY-MM-DD; default today in Asia/Taipei')
    hold.set_defaults(run=cmd_hold)
    release = commands.add_parser('release', help='a ticket merged into dev: drop the mark')
    release.add_argument('number', type=int)
    release.set_defaults(run=cmd_release)
    blocked = commands.add_parser('blocked', help='a ticket parked or failed: keep the mark')
    blocked.add_argument('number', type=int)
    blocked.add_argument('--reason', required=True)
    blocked.set_defaults(run=cmd_blocked)
    args = parser.parse_args(argv)
    args.run(args)


if __name__ == '__main__':
    main()

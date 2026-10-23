#!/usr/bin/env python3
"""Dispatch helper for the LAT orchestrator (stdlib only).

`card` creates the task card for an HCOM tag that was just launched; the agent's full name
comes from `hcom list --json`. `brief` turns a four-section Markdown file plus that card into
a ready-to-send task brief and prints the `hcom send` command. It never launches agents and
never sends anything. Hand-written cards and briefs stay allowed.
"""
import argparse
from datetime import date
import json
import os
from pathlib import Path
import re
import shlex
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lat_common import run_cli, write_text_atomic

LAT_DIR = Path(__file__).resolve().parents[1]
SECTIONS = ('目標與完成條件', '範圍與不能碰', '其他 Agent 與分工', '現場動作額度')
# Name of the file that stands in for `hcom list --json` (tests).
LIST_ENV = 'LAT_DISPATCH_HCOM_LIST'
TAG = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]*')
CARD_FIELD = re.compile(r'-\s+([^：\n]+)：\s*(.*)')
CARD_AGENT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?=$|[\s(（])')
NONE = '無'
LIVE_RULES = '''- Before acting, check every `preflight` item. If any item does not hold, report to the orchestrator first and do not act.
- Do live actions inside the `live actions` quota yourself; do not ask the orchestrator to approve each step.
- Report to the orchestrator only when: (1) you are about to exceed or have exceeded any quota; (2) a stop condition triggers; (3) a login, human-verification or risk-control signal appears; (4) a decision outside the Spec comes up; (5) you have the final result.
- If the quota is used up and the goal is not met, stop and report; never add quota yourself.
- The 現場動作額度 section above only supplements these two card fields; it never replaces them.'''
FIXED = '''## Fixed fields

- Working directory: {workdir}
- Report to: {orchestrator}
- Language: all agent-to-agent communication (hcom messages, hand-offs, reports) is in English.
- On completion report: where the results are, test results (for a full suite, attach the suite-gate record: the fingerprint, or the entry `suite-gate.py status` shows; do not rerun just to report), and anything unfinished.
- Stuck rule: if the same acceptance target fails 3 rounds of fix -> verify (fix -> deploy -> verify when there is a deploy step), report to {orchestrator} immediately with the failure evidence and your next hypothesis. Reset the count when the target passes or changes.
- Report with: `hcom send @{orchestrator} --name {agent}`. If you forget the syntax, run `hcom <command> --help`; do not guess.
- Always address messages: `@<name>` for one agent, `@<tag>-` for a group. Never run `hcom send` without `@`; it broadcasts to every agent.
- Nobody watches your terminal window, so do not explain anything there; send every report with `hcom send`.

## LAT hand-off

- Task card: {card}. Update it at the start, at checkpoints and at the end.
- Runs folder: {runs}
- Decisions directory: {decisions} (check pending decisions before starting).
- Finish all work before ending a turn. When only waiting is left, declare it with:
  `uv run --no-project python {lat_dir}/scripts/lat-watch.py wait --workspace {workspace} --agent {agent} --for <decision ID or agent name> --reason '<one sentence>'`
- For a timed wait, register an alarm:
  `uv run --no-project python {lat_dir}/scripts/lat-watch.py alarm --workspace {workspace} --agent {agent} --after 30 --reason 'Continue after the cooldown'`
- Do not use background programs to message yourself; HCOM rejects them.
'''


class Failure(Exception):
    """The request cannot be served; the message goes to stderr."""


def read_hcom_list():
    path = os.environ.get(LIST_ENV)
    try:
        text = Path(path).read_text() if path else run_cli(
            ['hcom', 'list', '--json'], timeout=30, failure='hcom list failed')
        value = json.loads(text)
    except (OSError, ValueError) as error:
        raise Failure(f'HCOM agent list unreadable: {error}') from error
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise Failure('HCOM agent list unreadable: not a list of agents')
    return value


def agent_for_tag(tag):
    names = sorted({item['name'] for item in read_hcom_list()
                    if item.get('tag') == tag and isinstance(item.get('name'), str)})
    if not names:
        raise Failure(f'no HCOM agent carries tag {tag!r}; launch it first, then rerun')
    if len(names) > 1:
        raise Failure(f'tag {tag!r} is not unique: {", ".join(names)}; use a tag of its own')
    return names[0]


def single_line(label, value):
    if '\n' in value or '\r' in value:
        raise Failure(f'{label} must be a single line')
    return value.strip()


def card_text(previous, fields):
    lines = [f'接續：{previous or NONE}', '']
    lines += [f'- {name}：{value}' for name, value in fields]
    return '\n'.join(lines) + '\n'


def make_card(args):
    tag = args.tag
    if not TAG.fullmatch(tag):
        raise Failure(f'invalid tag {tag!r}')
    for label, value in (('--live-actions', args.live_actions), ('--preflight', args.preflight)):
        if not value.strip():
            raise Failure(f'{label} must not be empty; write 無 when there is nothing to do')
    tasks = args.tasks.resolve()
    if not tasks.is_dir():
        raise Failure(f'task-card directory does not exist: {tasks}')
    agent = agent_for_tag(tag)
    day = args.date or date.today().isoformat()
    options = {
        'model': args.model, 'branch': args.branch, 'worktree': args.worktree,
        'base commit': args.base_commit, 'owned resources': args.owned_resources,
        'live actions': args.live_actions, 'preflight': args.preflight,
        '預計檢查數': args.expected_checks, '整套測試': args.full_suite, 'runs': args.runs,
        'temp paths': args.temp_paths, 'next step': args.next_step,
    }
    values = {name: single_line(name, value) for name, value in options.items()}
    fields = [
        ('agent', agent), ('orchestrator', single_line('--orchestrator', args.orchestrator)),
        ('model', values['model']), ('branch', values['branch']),
        ('worktree', values['worktree']), ('base commit', values['base commit']),
        ('status', 'dispatched'), ('owned resources', values['owned resources']),
        ('live actions', values['live actions']), ('preflight', values['preflight']),
        ('預計檢查數', values['預計檢查數']), ('整套測試', values['整套測試']),
        ('runs', values['runs']), ('temp paths', values['temp paths']),
        ('done so far', ''), ('next step', values['next step']),
        ('deliverable commit', '待 Orchestrator 從 Git 查證後填入'),
    ]
    stem, previous, number = f'{day}-{tag}', None, 1
    while True:
        name = f'{stem}.md' if number == 1 else f'{stem}-{number}.md'
        path = tasks / name
        done = tasks / 'done' / name
        if not path.exists() and not done.exists():
            break
        previous = done if done.exists() and not path.exists() else path
        number += 1
    try:
        with open(path, 'x', encoding='utf-8') as stream:
            stream.write(card_text(previous, fields))
    except FileExistsError as error:
        raise Failure(f'task card appeared meanwhile: {path}; rerun') from error
    print(path)
    print(f'agent: {agent}')


def read_card(path):
    if path is None:
        raise Failure('--card is required')
    try:
        text = Path(path).read_text(encoding='utf-8')
    except (OSError, UnicodeError) as error:
        raise Failure(f'task card unreadable: {error}') from error
    fields = {}
    for line in text.splitlines():
        match = CARD_FIELD.fullmatch(line)
        if match:
            fields.setdefault(match.group(1).strip(), match.group(2).strip())
    missing = [name for name in ('live actions', 'preflight') if not fields.get(name)]
    if missing:
        raise Failure(f'task card {path} lacks {" and ".join(missing)}; fill each '
                      '(write 無 when none) before generating a brief')
    for name in ('agent', 'orchestrator'):
        if not fields.get(name):
            raise Failure(f'task card {path} lacks the {name} field')
    match = CARD_AGENT.match(fields['agent'])
    if not match:
        raise Failure(f'task card agent field must start with an HCOM name: {fields["agent"]!r}')
    fields['agent'] = match.group(0)
    return fields


def split_sections(text):
    """Return ({title: body}, problems) for the four required `##` sections."""
    bodies, problems, current, seen_fence = {}, [], None, None
    for line in text.splitlines():
        stripped = line.strip()
        if re.match(r'(```|~~~)', stripped):
            marker = stripped[:3]
            seen_fence = None if seen_fence == marker else (seen_fence or marker)
        match = None if seen_fence else re.fullmatch(r'##[ \t]+(.+?)[ \t]*#*[ \t]*', line)
        title = match.group(1).strip() if match else None
        if title in SECTIONS:
            if title in bodies:
                problems.append(f'duplicate heading: ## {title}')
            current = title
            bodies.setdefault(title, [])
            continue
        if current is None:
            if stripped:
                problems.append('text before the first heading')
                current = ''
            continue
        if current:
            bodies[current].append(line)
    for title in SECTIONS:
        if title not in bodies:
            problems.append(f'missing section: ## {title}')
        elif not '\n'.join(bodies[title]).strip():
            problems.append(f'empty section: ## {title}')
    return {title: '\n'.join(lines).strip('\n') for title, lines in bodies.items()}, problems


def make_brief(args):
    card = read_card(args.card)
    source = Path(args.input)
    try:
        text = source.read_text(encoding='utf-8')
    except (OSError, UnicodeError) as error:
        raise Failure(f'input unreadable: {error}') from error
    bodies, problems = split_sections(text)
    if problems:
        raise Failure(f'{source} is not a valid brief input: ' + '; '.join(dict.fromkeys(problems)))
    card_path = Path(args.card).resolve()
    workspace = args.workspace
    if workspace is None:
        if card_path.parent.name == 'done':
            card_path_dir = card_path.parent.parent
        else:
            card_path_dir = card_path.parent
        if card_path_dir.name != 'tasks' or card_path_dir.parent.name != '.lat':
            raise Failure('--workspace is required when the card is not under <workspace>/.lat/tasks')
        workspace = card_path_dir.parent.parent
    workspace = Path(workspace).resolve()
    output = Path(args.output) if args.output else source.with_name(f'{source.stem}.brief.md')
    output = output.resolve()
    if output == source.resolve():
        raise Failure('--output must differ from the input file')
    worktree = card.get('worktree', '')
    workdir = worktree if worktree.startswith('/') else str(workspace)
    parts = [f'# Task brief for {card["agent"]}\n']
    parts += [f'## {title}\n\n{bodies[title]}\n' for title in SECTIONS]
    parts.append('## Task card live actions and preflight (authoritative; copied from the card)\n\n'
                 f'- live actions：{card["live actions"]}\n- preflight：{card["preflight"]}\n\n'
                 f'{LIVE_RULES}\n')
    parts.append(FIXED.format(
        workdir=workdir, orchestrator=card['orchestrator'], agent=card['agent'],
        card=card_path, runs=card.get('runs') or NONE, workspace=workspace,
        decisions=workspace / '.lat' / 'decisions', lat_dir=args.lat_dir.resolve()))
    write_text_atomic(output, '\n'.join(parts), mode=0o644)
    print(f'brief: {output}')
    print('send: hcom send @{} --intent request --name {} --file {}'.format(
        card['agent'], card['orchestrator'], shlex.quote(str(output))))


def build_parser():
    parser = argparse.ArgumentParser(description='LAT dispatch helper')
    commands = parser.add_subparsers(dest='command', required=True)
    card = commands.add_parser('card', help='Create the task card for a launched HCOM tag')
    card.add_argument('--tag', required=True)
    card.add_argument('--tasks', type=Path, required=True,
                      help='shared task-card directory (<workspace>/.lat/tasks)')
    card.add_argument('--orchestrator', required=True, help='HCOM name of the orchestrator')
    card.add_argument('--live-actions', required=True)
    card.add_argument('--preflight', required=True)
    card.add_argument('--date', help='YYYY-MM-DD; default today')
    for option in ('model', 'branch', 'worktree', 'base-commit', 'owned-resources',
                   'expected-checks', 'full-suite', 'runs', 'temp-paths', 'next-step'):
        card.add_argument(f'--{option}', default=NONE)
    brief = commands.add_parser('brief', help='Build the task brief from four sections + a card')
    brief.add_argument('--card', type=Path)
    brief.add_argument('--input', type=Path, required=True)
    brief.add_argument('--output', type=Path, help='default: <input>.brief.md beside the input')
    brief.add_argument('--workspace', type=Path,
                       help='main workspace; default derived from the card location')
    brief.add_argument('--lat-dir', type=Path, default=LAT_DIR,
                       help='LAT skill directory used in the wait/alarm commands')
    return parser


def main():
    args = build_parser().parse_args()
    try:
        {'card': make_card, 'brief': make_brief}[args.command](args)
    except (Failure, ValueError, OSError) as error:
        print(f'lat-dispatch: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

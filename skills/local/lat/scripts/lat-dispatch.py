#!/usr/bin/env python3
"""Dispatch helper for the LAT orchestrator (stdlib only).

`card` creates the task card for an HCOM tag that was just launched; the agent's full name
comes from `hcom list --json`. `brief` turns a four-section Markdown file plus that card into
a ready-to-send task brief and prints the `hcom send` command; its `--name` values are the
base names HCOM records for tagged senders. It never launches agents and
never sends anything. Hand-written cards and briefs stay allowed.

With --ledger, `card` also opens and assigns a row in the LAT work ledger (lat-ledger.py) and
writes the row into the card; `brief` then carries the row and the start/update/done commands.
With --preauth, `brief` runs lat-preauth's check for each named action and carries the ones
that are pre-authorized right now.
"""
import argparse
from datetime import date
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lat_common import hcom_send_name, run_cli, write_text_atomic

LAT_DIR = Path(__file__).resolve().parents[1]
SECTIONS = ('目標與完成條件', '範圍與不能碰', '其他 Agent 與分工', '現場動作額度')
# Name of the file that stands in for `hcom list --json` (tests).
LIST_ENV = 'LAT_DISPATCH_HCOM_LIST'
TAG = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]*')
CARD_FIELD = re.compile(r'-\s+([^：\n]+)：\s*(.*)')
CARD_AGENT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?=$|[\s(（])')
NONE = '無'
LEDGER_ROW = re.compile(r'(\d+)\s*\((/.+)\)')
LEDGER_OPTIONS = ('ticket', 'stage', 'evidence', 'deadline', 'depends')
CARD_RULE = 'Update it at the start, at checkpoints and at the end.'
CARD_RULE_READ_ONLY = 'The orchestrator maintains the task card; do not edit it.'
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
- Report with: `hcom send @{orchestrator} --name {agent_name}`. If you forget the syntax, run `hcom <command> --help`; do not guess.
- Always address messages: `@<name>` for one agent, `@<tag>-` for a group. Never run `hcom send` without `@`; it broadcasts to every agent.
- Nobody watches your terminal window, so do not explain anything there; send every report with `hcom send`.

## LAT hand-off

- Task card: {card}. {card_rule}
- Runs folder: {runs}
- Decisions directory: {decisions}. Check pending decisions before starting and before resuming or taking a follow-up instruction: stop work that depends on a pending decision and report it; keep going on authorized work it does not affect. No reply from the user is not approval.
- Other agents named in the sections above: contact them directly for what you need from them; do not route it through {orchestrator}.
- Finish all work before ending a turn. When only waiting is left, declare it with:
  `uv run --no-project python {lat_script} wait --workspace {workspace} --agent {agent} --for <decision ID or agent name> --reason '<one sentence>'`
- For a timed wait, register an alarm:
  `uv run --no-project python {lat_script} alarm --workspace {workspace} --agent {agent} --after 30 --reason 'Continue after the cooldown'`
- Do not use background programs to message yourself; HCOM rejects them.
'''
LEDGER_FIXED = '''
## Work ledger

- Your ledger row is {row} in {ledger}. Register with these commands (the ledger is in the main workspace; always use this absolute path, even from a worktree):
  - Start, with your own estimate of the finish time: `{cmd} start {row} --ledger {ledger_arg} --by {agent} --eta +<N>m`
  - At each checkpoint: `{cmd} update {row} --ledger {ledger_arg} --by {agent} --progress '<one sentence>'`; when the estimate or deadline moves, add `--eta` or `--deadline` and `--reason`.
  - Close, with the evidence the row declares (a commit, a suite-gate fingerprint and/or a report file; the tool checks it exists): `{cmd} done {row} --ledger {ledger_arg} --by {agent} --commit <sha> --gate <fingerprint> --file <absolute path>` (pass only the kinds the row declares).
- `done` writes `status` and `deliverable commit` into the task card; do not fill them by hand.
'''
PREAUTH_REQUEST = re.compile(r'([a-z][a-z-]*)(?::(\S+))?')
PREAUTH_FIXED = '''## Pre-authorized actions (lat-preauth check when this brief was made)

{lines}

These held when the brief was made; the conditions behind them (branch list, full-suite gate, main checkout at the integration branch's tip) can change before you act. Right before acting, rerun `{check}`. Act without asking only if it still prints allow, then report the action, the commit and that line to {orchestrator} so it logs them with `lat-preauth record`.
{notices}'''
PREAUTH_NOTICES = '''
Deploying and installing ({actions}) also need two HCOM notices that {orchestrator} itself sends to the other controllers. After the recheck, ask {orchestrator} for the before notice and start only after it confirms it was sent; note the start time in ISO form with a time zone. When done, succeeded or failed, report the start time and the result to {orchestrator} so it sends the after notice and logs the action.
'''
LEDGER_MISSING = '''
## Work ledger

- This card has no ledger row, so there are no ledger commands to run; report to {orchestrator} as usual.
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


def agent_for_tag(tag, agent=None):
    names = sorted({item['name'] for item in read_hcom_list()
                    if item.get('tag') == tag and isinstance(item.get('name'), str)})
    if not names:
        raise Failure(f'no HCOM agent carries tag {tag!r}; launch it first, then rerun')
    if agent is not None:
        if agent not in names:
            raise Failure(f'--agent {agent!r} is not among the agents carrying tag {tag!r}: '
                          f'{", ".join(names)}')
        return agent
    if len(names) > 1:
        raise Failure(f'tag {tag!r} is not unique: {", ".join(names)}; use a tag of its own or pass --agent')
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
    ledger = ledger_request(args)
    agent = agent_for_tag(tag, args.agent)
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
    if ledger:
        row = open_ledger_row(args, ledger, fields[1][1], agent, path)
        fields.insert(7, ('ledger row', f'{row} ({ledger["path"]})'))
    try:
        with open(path, 'x', encoding='utf-8') as stream:
            stream.write(card_text(previous, fields))
    except FileExistsError as error:
        where = f' (ledger row {row} is already assigned to it)' if ledger else ''
        raise Failure(f'task card appeared meanwhile: {path}{where}; rerun') from error
    print(path)
    print(f'agent: {agent}')
    if ledger:
        print(f'ledger row: {row}')


def ledger_request(args):
    """Validate the ledger options of `card`; None when the card is made without a row."""
    given = [name for name in LEDGER_OPTIONS if getattr(args, name)]
    if not args.ledger:
        if given:
            raise Failure('--ticket, --stage, --evidence, --deadline and --depends need --ledger')
        return None
    missing = [f'--{name}' for name in ('ticket', 'stage', 'evidence', 'deadline')
               if not getattr(args, name)]
    if missing:
        raise Failure(f'--ledger also needs {", ".join(missing)}')
    path = args.ledger
    if not path.is_absolute():
        raise Failure(f'--ledger must be an absolute path: {path}')
    if not path.is_file():
        raise Failure(f'ledger does not exist: {path}; create it with lat-ledger.py init first')
    return {'path': str(path)}


def run_ledger(args, command, *rest):
    script = args.lat_dir.resolve() / 'scripts' / 'lat-ledger.py'
    try:
        return run_cli([sys.executable, str(script), command, *rest], timeout=60,
                       failure=f'lat-ledger {command} failed').strip()
    except ValueError as error:
        raise Failure(str(error)) from error


def open_ledger_row(args, ledger, orchestrator, agent, card):
    base = ['--ledger', ledger['path'], '--by', orchestrator]
    add = ['--ticket', args.ticket, '--stage', args.stage, '--deadline', args.deadline]
    for evidence in args.evidence:
        add += ['--evidence', evidence]
    if args.depends:
        add += ['--depends', args.depends]
    if args.branch != NONE:
        add += ['--branch', args.branch.strip()]
    row = run_ledger(args, 'add', *base, *add)
    if not row.isdigit():
        raise Failure(f'lat-ledger add printed an unexpected row number: {row!r}')
    try:
        run_ledger(args, 'assign', row, *base, '--agent', agent, '--card', str(card))
    except Failure as error:
        raise Failure(f'{error}; ledger row {row} was added but not assigned, no card made') from error
    return row


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
    row = LEDGER_ROW.fullmatch(fields.get('ledger row', ''))
    fields['ledger row'] = row.groups() if row else None
    return fields


def split_sections(text):
    """Return ({title: body}, problems) for the four required `##` sections."""
    bodies, problems, current, seen_fence = {}, [], None, None
    for line in text.splitlines():
        stripped = line.strip()
        fence = re.match(r'(`{3,}|~{3,})(.*)', stripped)
        if fence:
            marker = fence.group(1)
            if seen_fence is None:
                seen_fence = marker
            elif (marker[0] == seen_fence[0] and len(marker) >= len(seen_fence)
                  and not fence.group(2).strip()):
                seen_fence = None
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


def load_preauth():
    path = Path(__file__).resolve().parent / 'lat-preauth.py'
    spec = importlib.util.spec_from_file_location('lat_preauth', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def preauth_part(args, workspace, orchestrator):
    """The pre-authorized-actions section for the --preauth requests that check allows, or
    None when none does; the ones that ask are named on stderr."""
    requests = []
    for request in args.preauth or ():
        match = PREAUTH_REQUEST.fullmatch(request)
        if not match:
            raise Failure(f'--preauth must be ACTION or ACTION:BRANCH, not {request!r}')
        requests.append(match.groups())
    if not requests:
        return None
    preauth = load_preauth()
    session = args.session_id or next(
        (os.environ[key] for key in preauth.SESSION_ENVS if os.environ.get(key)), None)
    lines, notified = [], []
    for action, branch in requests:
        result = preauth.evaluate(action, branch=branch, workspace=workspace, session=session)
        line = preauth.verdict_line(result)
        if result['verdict'] == 'allow':
            lines.append(f'- {line}')
            notified += [action] if action in preauth.MAIN_CHECKOUT_ACTIONS else []
        else:
            print(f'lat-dispatch: not pre-authorized, left out of the brief: {line}',
                  file=sys.stderr)
    if not lines:
        return None
    check = ['uv', 'run', '--no-project', 'python',
             str(Path(__file__).resolve().parent / 'lat-preauth.py'), 'check',
             '--workspace', str(workspace)]
    if session:
        check += ['--session-id', session]
    check = shlex.join(check) + ' --action <action> [--branch <branch>]'
    notices = PREAUTH_NOTICES.format(actions=', '.join(dict.fromkeys(notified)),
                                     orchestrator=orchestrator) if notified else ''
    return PREAUTH_FIXED.format(lines='\n'.join(lines), check=check, orchestrator=orchestrator,
                                notices=notices)


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
    extra = None
    if args.include:
        try:
            extra = Path(args.include).read_text(encoding='utf-8').strip('\n')
        except (OSError, UnicodeError) as error:
            raise Failure(f'--include unreadable: {error}') from error
    parts = [f'# Task brief for {card["agent"]}\n']
    parts += [f'## {title}\n\n{bodies[title]}\n' for title in SECTIONS]
    if extra:
        parts.append(extra + '\n')
    parts.append('## Task card live actions and preflight (authoritative; copied from the card)\n\n'
                 f'- live actions：{card["live actions"]}\n- preflight：{card["preflight"]}\n\n'
                 f'{LIVE_RULES}\n')
    agents = read_hcom_list()
    preauth = preauth_part(args, workspace, card['orchestrator'])
    if preauth:
        parts.append(preauth)
    fixed = FIXED.format(
        workdir=workdir, orchestrator=card['orchestrator'], agent=card['agent'],
        agent_name=hcom_send_name(card['agent'], agents),
        card=card_path, card_rule=CARD_RULE_READ_ONLY if args.read_only else CARD_RULE,
        runs=card.get('runs') or NONE, workspace=shlex.quote(str(workspace)),
        decisions=workspace / '.lat' / 'decisions',
        lat_script=shlex.quote(str(args.lat_dir.resolve() / 'scripts' / 'lat-watch.py')))
    if card['ledger row']:
        row, ledger = card['ledger row']
        fixed += LEDGER_FIXED.format(
            row=row, ledger=ledger, ledger_arg=shlex.quote(ledger), agent=card['agent'],
            cmd='uv run --no-project python ' + shlex.quote(
                str(args.lat_dir.resolve() / 'scripts' / 'lat-ledger.py')))
    else:
        print(f'lat-dispatch: warning: card {card_path} has no ledger row; the brief carries '
              'no ledger commands', file=sys.stderr)
        fixed += LEDGER_MISSING.format(orchestrator=card['orchestrator'])
    parts.append(fixed)
    write_text_atomic(output, '\n'.join(parts), mode=0o644)
    print(f'brief: {output}')
    print('hcom send @{} --intent request --name {} --file {}'.format(
        card['agent'], hcom_send_name(card['orchestrator'], agents), shlex.quote(str(output))))


def build_parser():
    parser = argparse.ArgumentParser(description='LAT dispatch helper')
    commands = parser.add_subparsers(dest='command', required=True)
    card = commands.add_parser('card', help='Create the task card for a launched HCOM tag')
    card.add_argument('--tag', required=True)
    card.add_argument('--agent', help='full HCOM name; picks one agent when the tag matches several')
    card.add_argument('--tasks', type=Path, required=True,
                      help='shared task-card directory (<workspace>/.lat/tasks)')
    card.add_argument('--orchestrator', required=True, help='HCOM name of the orchestrator')
    card.add_argument('--live-actions', required=True)
    card.add_argument('--preflight', required=True)
    card.add_argument('--date', help='YYYY-MM-DD; default today')
    for option in ('model', 'branch', 'worktree', 'base-commit', 'owned-resources',
                   'expected-checks', 'full-suite', 'runs', 'temp-paths', 'next-step'):
        card.add_argument(f'--{option}', default=NONE)
    card.add_argument('--ledger', type=Path,
                      help='absolute path of the work ledger; adds and assigns a row for this card')
    card.add_argument('--ticket', help='ledger row: ticket')
    card.add_argument('--stage', help='ledger row: stage (see lat-ledger.py add --help)')
    card.add_argument('--evidence', action='append',
                      help='ledger row: evidence kinds (commit, gate, file); comma-separated or repeated')
    card.add_argument('--deadline', help='ledger row: latest finish, ISO 8601 or +N[m|h|d]')
    card.add_argument('--depends', help='ledger row: comma-separated item numbers it waits for')
    card.add_argument('--lat-dir', type=Path, default=LAT_DIR,
                      help='LAT skill directory holding scripts/lat-ledger.py')
    brief = commands.add_parser('brief', help='Build the task brief from four sections + a card')
    brief.add_argument('--card', type=Path)
    brief.add_argument('--input', type=Path, required=True)
    brief.add_argument('--output', type=Path, help='default: <input>.brief.md beside the input')
    brief.add_argument('--read-only', action='store_true',
                       help='read-only task: the agent must not edit the task card')
    brief.add_argument('--include', type=Path,
                       help='file appended after the four sections, before the live actions block')
    brief.add_argument('--workspace', type=Path,
                       help='main workspace; default derived from the card location')
    brief.add_argument('--lat-dir', type=Path, default=LAT_DIR,
                       help='LAT skill directory used in the wait/alarm commands')
    brief.add_argument('--preauth', action='append', metavar='ACTION[:BRANCH]',
                       help='action the task may take (e.g. merge:dev, deploy-test); repeatable. '
                            'Those lat-preauth check allows now go into the brief')
    brief.add_argument('--session-id', help='controller session ID for --preauth; default '
                                            '$CLAUDE_CODE_SESSION_ID, then $CODEX_THREAD_ID')
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

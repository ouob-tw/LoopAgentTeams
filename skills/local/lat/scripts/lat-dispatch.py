#!/usr/bin/env python3
"""Dispatch helper for the LAT orchestrator (stdlib only).

`card` creates the task card for an HCOM tag that was just launched; the agent's and the
orchestrator's full names come from `hcom list --json`. With --before-launch the card is made
before the agent exists, so its brief can go into the launch itself (`hcom … --hcom-prompt`):
the agent field reads 待綁定 and the agent's first step is `card bind`, which writes its full
name from $HCOM_INSTANCE_NAME (checked against the card's tag) and assigns its ledger row.
With --native, the card is for a Claude built-in agent: its name comes from --agent as given and
the card is marked `native agent：是`.
`card close` ends a card: sets its status and deliverable commit, moves it to done/ and points its
ledger row at the new path, all or nothing. `--status merged` on a card with a ledger row also
names the long-lived branch that holds the work (--merged-into), so `check` still finds it once the
worktree and task branch are gone.
`brief` turns a four-section Markdown file plus that card into a ready-to-send task brief and
prints the `hcom send` command; its `--name` values are the base names HCOM records for tagged
senders. For a card still waiting for `card bind` the brief names the agent as
"$HCOM_INSTANCE_NAME", opens with the bind step and prints the `--hcom-prompt` launch argument.
It never launches agents and never sends anything. Hand-written cards and briefs stay allowed.

With --ledger, `card` also opens and assigns a row in the LAT work ledger (lat-ledger.py) and
writes the row into the card; `--tiny` with both declarations puts the ticket on the tiny-change
lane (the ledger marks its rows and refuses a card naming several tickets); `brief` then
carries the row and the start/update/done commands.
With --preauth, `brief` runs lat-preauth's check for each named action and carries the ones
that are pre-authorized right now.
"""
import argparse
from datetime import date
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lat_common import (full_hcom_name, hcom_send_name, run_cli, same_controller, shared_lat_dir,
                         write_text_atomic)

LAT_DIR = Path(__file__).resolve().parents[1]
SECTIONS = ('目標與完成條件', '範圍與不能碰', '其他 Agent 與分工', '現場動作額度')
# Name of the file that stands in for `hcom list --json` (tests).
LIST_ENV = 'LAT_DISPATCH_HCOM_LIST'
TAG = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]*')
CARD_FIELD = re.compile(r'-\s+([^：\n]+)：\s*(.*)')
CARD_AGENT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?=$|[\s(（])')
NONE = '無'
PENDING = '待綁定'
STAGE_ALIASES = {'implement': 'impl'}
CLOSE_STATUSES = ('committed', 'merged', 'completed')
LEDGER_ROW = re.compile(r'(\d+)\s*\((/.+)\)')
LEDGER_OPTIONS = ('ticket', 'title', 'stage', 'evidence', 'deadline', 'depends', 'repo',
                  'old_round', 'tiny', 'no_feature', 'no_format_change')
TINY_FIELD = '是；主控聲明不新增功能、不改資料或存檔格式'
CARD_RULE = 'Update it at the start, at checkpoints and at the end.'
BIND_SCOPE_NOTE = 'Write restrictions in this section do not apply to the bind step at the top.'
SCOPE_NOTE = ('Write restrictions in this section do not apply to updating the task card '
              'or running work-ledger commands.')
CARD_RULE_READ_ONLY = 'The orchestrator maintains the task card; do not edit it.'
CARD_RULE_READ_ONLY_BIND = ('Apart from the bind step at the top, the orchestrator maintains '
                            'the task card; do not edit it.')
LIVE_RULES = '''- Before acting, check every `preflight` item. If any item does not hold, report to the orchestrator first and do not act.
- Do live actions inside the `live actions` quota yourself; do not ask the orchestrator to approve each step.
- QA with live actions keeps at least one use of the quota for the final candidate version and starts spending the quota only after the implementer says the version is final.
- Report to the orchestrator only when: (1) you are about to exceed or have exceeded any quota; (2) a stop condition triggers; (3) a login, human-verification or risk-control signal appears; (4) a decision outside the Spec comes up; (5) you have the final result.
- If the quota is used up and the goal is not met, stop and report; never add quota yourself.
- The 現場動作額度 section above only supplements these two card fields; it never replaces them.'''
VISUAL_RULES = '''- This work changes something visible, so it is accepted only after someone other than the implementer (the orchestrator or an independent viewer) has looked at it and said whether it looks right against what the user wants. Passing tests or matching a prototype does not count.
- Implementing: deliver frame sheets covering each changed look, including mid-motion and transition frames, and report their paths. Open web pages in a real browser, try every control and check the console first.
- Use the `ui-copy` skill when building the screen or writing its requirements.
- A screen that needs its explanatory text read to be understood counts as wrong.
- If a prototype or reference itself looks wrong, raise it to the orchestrator; do not copy the defect.
- Turn each defect found by eye into a testable bound where possible, and show the test fails on the defective version (example: water surface height limit 5%, defective version 86.9%).'''
FIXED = '''## Fixed fields

- Working directory: {workdir}
- Report to: {orchestrator}
- Language: all agent-to-agent communication (hcom messages, hand-offs, reports) is in English.
- On completion report: where the results are, test results (for a full suite, attach the suite-gate record: the fingerprint, or the entry `suite-gate.py status` shows; do not rerun just to report), and anything unfinished. {report_rule}
- Stuck rule: if the same acceptance target fails 3 rounds of fix -> verify (fix -> deploy -> verify when there is a deploy step), report to {orchestrator} immediately with the failure evidence and your next hypothesis. Reset the count when the target passes or changes.
- Report only results, blockers, live-action quota hits and questions outside the Spec; never send a start or progress ack.
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
  - At each checkpoint: `{cmd} update {row} --ledger {ledger_arg} --by {agent} --progress '<one sentence>'`; when the estimate moves, add `--eta` and `--reason` (the tool keeps the deadline at the estimate + 1h).
  - Close, with the evidence the row declares (a commit, a suite-gate fingerprint and/or a report file; the tool checks it exists): `{cmd} done {row} --ledger {ledger_arg} --by {agent} --commit <sha> --gate <fingerprint> --file <absolute path>` (pass only the kinds the row declares).
  - After closing, if your verdict or the delivered version changes: `{cmd} amend {row} --ledger {ledger_arg} --by {agent} --reason '<what changed>'`; add `--commit`, `--gate` or `--file` to replace that evidence.
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
REPORT_FILE = ('Write the full report to {path} first (later reports to the same file '
               'replace it), then send the path and a few-line summary.')
BIND_STEP = '''Before anything else, bind this task card to yourself:
`uv run --no-project python {script} card bind --card {card}`
It writes your HCOM name into the card and assigns your ledger row. If it fails, report the
error to {orchestrator} and wait.
'''
LAUNCH_PROMPT = 'Your task from {orchestrator} is in {brief}. Read that file and follow it.'
# The agent's own HCOM base name, expanded by its shell; the LAT tools resolve it to the full name.
AGENT_ENV = '"$HCOM_INSTANCE_NAME"'
REPORT_IN_MESSAGE = 'The card names no runs folder, so send the full report in the message.'
REVIEW_RESULT = '''- Record each review round's result before you close its reviewers; `done` is refused until this row has one recorded since its latest start. A clean review: `{cmd} review-result --row {row} --ledger {ledger_arg} --by {agent} --reviewer <HCOM name> --clean`; a review with findings: the same with one `--finding '<甲|乙|丙>:<one line>'` per finding instead of `--clean`, which prints the problem ids. Record one result per reviewer; a native sub-agent goes by the name you gave it.
- When a finding is settled: `{cmd} problem-update <id> --ledger {ledger_arg} --by {agent} --fixed <commit>` (or `--known-limit`, `--wontfix '<why>'`, `--new-ticket <#N>`).
'''
QA_FINDINGS = '''- Record each problem you find when you find it: `{cmd} problem --row {row} --ledger {ledger_arg} --by {agent} --stage qa --level <甲|乙|丙> --text '<one line>'` (add `--caught <gate fingerprint>` when an automatic test caught it). `done` is refused until you recorded one in this round; when you found none, add `--no-findings` to `done`.
'''
SPEC_COVERAGE = '''
## Spec coverage

- Before drafting scenarios, map every consensus item and every Implementation Decisions entry of the parent spec to the ticket whose acceptance criteria cover it.
- Put the entries no ticket covers at the top of your report, so {orchestrator} can add them to a ticket before implementers are dispatched.
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


def agent_for_tag(items, tag, agent=None):
    names = sorted({item['name'] for item in items
                    if item.get('tag') == tag and isinstance(item.get('name'), str)})
    if not names:
        raise Failure(f'no HCOM agent carries tag {tag!r}; launch it first, then rerun')
    if agent is not None:
        try:
            return full_hcom_name(names, agent, '--agent')
        except ValueError as error:
            raise Failure(f'{error} (agents carrying tag {tag!r})') from None
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
    for label, value in (('--live-actions', args.live_actions), ('--preflight', args.preflight),
                         ('--visual-acceptance', args.visual_acceptance)):
        if not value.strip():
            raise Failure(f'{label} must not be empty; write 無 when there is nothing to do')
    tasks = args.tasks.resolve()
    if not tasks.is_dir():
        raise Failure(f'task-card directory does not exist: {tasks}')
    ledger = ledger_request(args)
    if args.before_launch and (args.agent or args.native):
        raise Failure('--before-launch makes the card before the agent exists; '
                      'it takes no --agent or --native')
    if args.native and (not args.agent or not CARD_AGENT.fullmatch(args.agent)):
        raise Failure('--native needs --agent with the name the orchestrator gave the agent')
    items = read_hcom_list()
    agent = (PENDING if args.before_launch else args.agent if args.native
             else agent_for_tag(items, tag, args.agent))
    orchestrator = full_hcom_name(
        {item['name'] for item in items if isinstance(item.get('name'), str)},
        single_line('--orchestrator', args.orchestrator), '--orchestrator')
    day = args.date or date.today().isoformat()
    options = {
        'model': args.model, 'branch': args.branch, 'worktree': args.worktree,
        'base commit': args.base_commit, 'owned resources': args.owned_resources,
        'live actions': args.live_actions, 'preflight': args.preflight,
        '視覺驗收': args.visual_acceptance,
        '預計檢查數': args.expected_checks, '整套測試': args.full_suite, 'runs': args.runs,
        'temp paths': args.temp_paths, 'next step': args.next_step,
    }
    values = {name: single_line(name, value) for name, value in options.items()}
    fields = [
        ('agent', agent), *([('tag', tag)] if args.before_launch else []),
        ('orchestrator', orchestrator),
        *([('native agent', '是')] if args.native else []),
        ('model', values['model']), ('branch', values['branch']),
        ('worktree', values['worktree']), ('base commit', values['base commit']),
        ('status', 'dispatched'), ('owned resources', values['owned resources']),
        ('live actions', values['live actions']), ('preflight', values['preflight']),
        ('視覺驗收', values['視覺驗收']),
        ('預計檢查數', values['預計檢查數']), ('整套測試', values['整套測試']),
        ('runs', values['runs']), ('temp paths', values['temp paths']),
        *([('tiny lane', TINY_FIELD)] if args.tiny else []),
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
        row = open_ledger_row(args, ledger, orchestrator, None if args.before_launch else agent,
                              path)
        fields.insert([name for name, _ in fields].index('status') + 1,
                      ('ledger row', f'{row} ({ledger["path"]})'))
    try:
        with open(path, 'x', encoding='utf-8') as stream:
            stream.write(card_text(previous, fields))
    except FileExistsError as error:
        where = f' (ledger row {row} is already assigned to it)' if ledger else ''
        raise Failure(f'task card appeared meanwhile: {path}{where}; rerun') from error
    print(path)
    print(f'agent: {agent}' + (' (the agent binds itself with `card bind`)'
                                if args.before_launch else ''))
    if ledger:
        print(f'ledger row: {row}')


def ledger_request(args):
    """Validate the ledger options of `card`; None when the card is made without a row."""
    given = [name for name in LEDGER_OPTIONS if getattr(args, name)]
    if not args.ledger:
        if given:
            raise Failure('--ticket, --title, --stage, --evidence, --deadline, --depends, --repo, '
                          '--old-round, --tiny, --no-feature and --no-format-change need --ledger')
        return None
    missing = [f'--{name}' for name in ('ticket', 'stage', 'evidence')
               if not getattr(args, name)]
    if missing:
        raise Failure(f'--ledger also needs {", ".join(missing)}')
    if args.repo and not Path(args.repo).is_absolute():
        raise Failure(f'--repo must be the absolute path of the local git checkout, not '
                      f'{args.repo!r} (an owner/repo name is not accepted)')
    path = args.ledger
    if not path.is_absolute():
        raise Failure(f'--ledger must be an absolute path: {path}')
    if not path.is_file():
        raise Failure(f'ledger does not exist: {path}; create it with lat-ledger.py init first')
    if args.deadline:
        print('lat-dispatch: --deadline ignored; the ledger keeps the deadline at the estimate '
              '+ 1h', file=sys.stderr)
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
    stage = STAGE_ALIASES.get(args.stage, args.stage)
    add = ['--ticket', args.ticket, '--stage', stage]
    if args.title:
        add += ['--title', args.title]
    for evidence in args.evidence:
        add += ['--evidence', evidence]
    if args.depends:
        add += ['--depends', args.depends]
    if args.repo:
        add += ['--repo', args.repo]
    if args.old_round:
        add.append('--old-round')
    add += [f'--{name}' for name in ('tiny', 'no-feature', 'no-format-change')
            if getattr(args, name.replace('-', '_'))]
    if args.branch != NONE:
        add += ['--branch', args.branch.strip()]
    row = run_ledger(args, 'add', *base, *add)
    if not row.isdigit():
        raise Failure(f'lat-ledger add printed an unexpected row number: {row!r}')
    if agent is None:  # --before-launch: `card bind` assigns the row
        return row
    try:
        run_ledger(args, 'assign', row, *base, '--agent', agent, '--card', str(card),
                   *(['--native'] if args.native else []))
    except Failure as error:
        raise Failure(f'{error}; ledger row {row} was added but not assigned, no card made') from error
    return row


def bind_card(args):
    """Write the launched agent's full HCOM name into a --before-launch card and assign its
    ledger row. The agent runs it with its own $HCOM_INSTANCE_NAME and $HCOM_TAG; the
    orchestrator can pass --agent instead. Binds of cards in one directory run one at a time,
    so a second bind of the same card sees it bound; a failed assignment puts the card back."""
    path = Path(args.card).resolve()
    try:
        lock = os.open(path.parent, os.O_RDONLY)
    except OSError as error:
        raise Failure(f'task card unreadable: {error}') from error
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        bind_locked(args, path)
    finally:
        os.close(lock)


def bind_locked(args, path):
    try:
        original = path.read_bytes()
        text = original.decode('utf-8')
    except (OSError, UnicodeError) as error:
        raise Failure(f'task card unreadable: {error}') from error
    fields, index = {}, None
    lines = text.splitlines(keepends=True)
    for number, line in enumerate(lines):
        match = CARD_FIELD.fullmatch(line.strip())
        if match and match.group(1).strip() not in fields:
            fields[match.group(1).strip()] = match.group(2).strip()
            index = number if match.group(1).strip() == 'agent' else index
    if fields.get('agent') != PENDING:
        raise Failure(f'task card {path} is already bound to {fields.get("agent")}; nothing changed'
                      if fields.get('agent') else f'task card {path} lacks the agent field')
    tag = fields.get('tag', '')
    if not TAG.fullmatch(tag):
        raise Failure(f'task card {path} lacks a valid tag field')
    name = args.agent
    if not name:
        name, own_tag = os.environ.get('HCOM_INSTANCE_NAME'), os.environ.get('HCOM_TAG')
        if not name:
            raise Failure('HCOM_INSTANCE_NAME is not set: run this as the launched agent, '
                          'or pass --agent <name>')
        if own_tag != tag:
            raise Failure(f'this agent carries tag {own_tag!r}, but the card is for tag {tag!r}; '
                          'nothing changed')
    agent = agent_for_tag(read_hcom_list(), tag, name)
    ending = '\n' if lines[index].endswith('\n') else ''
    lines[index] = f'- agent：{agent}{ending}'
    # The expected bytes keep an edit made outside the bind lock from being overwritten.
    written = write_text_atomic(path, ''.join(lines), expected=original)
    row = LEDGER_ROW.fullmatch(fields.get('ledger row', ''))
    if row:
        number, ledger = row.groups()
        try:
            run_ledger(args, 'assign', number, '--ledger', ledger, '--agent', agent,
                       '--card', str(path))
        except Failure:
            write_text_atomic(path, text, expected=written)
            raise
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
    missing = [name for name in ('live actions', 'preflight', '視覺驗收') if not fields.get(name)]
    if missing:
        raise Failure(f'task card {path} lacks {" and ".join(missing)}; fill each '
                      '(write 無 when none) before generating a brief')
    for name in ('agent', 'orchestrator'):
        if not fields.get(name):
            raise Failure(f'task card {path} lacks the {name} field')
    if fields['agent'] == PENDING:  # --before-launch card: the agent runs `card bind` first
        if not TAG.fullmatch(fields.get('tag', '')):
            raise Failure(f'task card {path} waits for `card bind` but lacks a valid tag field')
        fields['agent'] = None
    else:
        match = CARD_AGENT.match(fields['agent'])
        if not match:
            raise Failure(f'task card agent field must start with an HCOM name: '
                          f'{fields["agent"]!r}')
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


def load_script(name):
    path = Path(__file__).resolve().parent / f'{name}.py'
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
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
    preauth = load_script('lat-preauth')
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


def former_controllers(workspace, orchestrator):
    """HCOM names of the controllers whose handovers lead to `orchestrator`, per session records."""
    handovers = {}
    for path in (shared_lat_dir(workspace) / 'sessions').glob('*.json'):
        try:
            record = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue  # this check only warns; lat-session reports a damaged record
        if not isinstance(record, dict):
            continue
        name, successor = record.get('hcom_name'), record.get('successor')
        if name and successor and isinstance(name, str) and isinstance(successor, str):
            handovers[name] = successor
    former, current = set(), {orchestrator}
    while current:
        current = {name for name, successor in handovers.items() if name not in former
                   and any(same_controller(successor, full) for full in current)}
        former |= current
    return former


def warn_former_controllers(text, workspace, orchestrator):
    """The fixed fields already name the current controller, so an older name in the input
    would send the agent's reports to someone who has left."""
    keep = {orchestrator, orchestrator.rsplit('-', 1)[-1]}
    for name in sorted(former_controllers(workspace, orchestrator)):
        spellings = {name, name.rsplit('-', 1)[-1]} - keep
        if any(re.search(rf'(?<![A-Za-z0-9_-]){re.escape(word)}(?![A-Za-z0-9_-])', text) for word in spellings):
            print(f'lat-dispatch: warning: the input names former orchestrator {name}; '
                  f'{orchestrator} took over, so change it unless it is only background',
                  file=sys.stderr)


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
    warn_former_controllers('\n'.join([text, extra or '']), workspace, card['orchestrator'])
    pending = card['agent'] is None
    if pending:
        parts = [f'# Task brief for the agent tagged {card["tag"]}\n', BIND_STEP.format(
            script=shlex.quote(str(args.lat_dir.resolve() / 'scripts' / 'lat-dispatch.py')),
            card=shlex.quote(str(card_path)), orchestrator=card['orchestrator'])]
    else:
        parts = [f'# Task brief for {card["agent"]}\n']
    for title in SECTIONS:
        note = (f'\n{BIND_SCOPE_NOTE if args.read_only else SCOPE_NOTE}\n'
                if title == SECTIONS[1] and (pending or not args.read_only) else '')
        parts.append(f'## {title}\n\n{bodies[title]}\n{note}')
    if extra:
        parts.append(extra + '\n')
    parts.append('## Task card live actions and preflight (authoritative; copied from the card)\n\n'
                 f'- live actions：{card["live actions"]}\n- preflight：{card["preflight"]}\n\n'
                 f'{LIVE_RULES}\n')
    visual = card['視覺驗收']
    parts.append('## Task card visual acceptance (authoritative; copied from the card)\n\n'
                 f'- 視覺驗收：{visual}\n' + ('' if visual == NONE else f'\n{VISUAL_RULES}\n'))
    agents = read_hcom_list()
    preauth = preauth_part(args, workspace, card['orchestrator'])
    if preauth:
        parts.append(preauth)
    runs = card.get('runs') or NONE
    agent = AGENT_ENV if pending else card['agent']
    report_rule = (REPORT_FILE.format(
                       path=Path(runs) / f'report-{card_path.stem if pending else agent}.md')
                   if runs.startswith('/') else REPORT_IN_MESSAGE)
    fixed = FIXED.format(
        workdir=workdir, orchestrator=card['orchestrator'], agent=agent,
        report_rule=report_rule,
        agent_name=AGENT_ENV if pending else hcom_send_name(agent, agents),
        card=card_path, card_rule=(CARD_RULE if not args.read_only else
                                   CARD_RULE_READ_ONLY_BIND if pending else CARD_RULE_READ_ONLY),
        runs=runs, workspace=shlex.quote(str(workspace)),
        decisions=workspace / '.lat' / 'decisions',
        lat_script=shlex.quote(str(args.lat_dir.resolve() / 'scripts' / 'lat-watch.py')))
    if card['ledger row']:
        row, ledger = card['ledger row']
        commands = dict(row=row, ledger=ledger, ledger_arg=shlex.quote(ledger), agent=agent,
                        cmd='uv run --no-project python ' + shlex.quote(
                            str(args.lat_dir.resolve() / 'scripts' / 'lat-ledger.py')))
        fixed += LEDGER_FIXED.format(**commands)
        stage = row_stage(ledger, row)
        if stage == 'impl':
            fixed += REVIEW_RESULT.format(**commands)
        if stage == 'qa':
            fixed += QA_FINDINGS.format(**commands)
        if stage == 'qa-draft':
            fixed += SPEC_COVERAGE.format(orchestrator=card['orchestrator'])
    else:
        print(f'lat-dispatch: warning: card {card_path} has no ledger row; the brief carries '
              'no ledger commands', file=sys.stderr)
        fixed += LEDGER_MISSING.format(orchestrator=card['orchestrator'])
    parts.append(fixed)
    write_text_atomic(output, '\n'.join(parts), mode=0o644)
    print(f'brief: {output}')
    if pending:  # the launch carries the brief: `hcom 1 <client> … --go --hcom-prompt …`
        print('--hcom-prompt ' + shlex.quote(LAUNCH_PROMPT.format(
            orchestrator=card['orchestrator'], brief=output)))
        return
    # --intent request makes HCOM notify the sender at the agent's next turn end, even with
    # background work still running; the stall watch covers a card agent that really stops.
    print('hcom send @{} --name {} --file {}'.format(
        card['agent'], hcom_send_name(card['orchestrator'], agents), shlex.quote(str(output))))


def row_stage(ledger, row):
    """The stage of ledger row `row`, or None (with a warning) when the ledger cannot be read."""
    try:
        items = json.loads(Path(ledger).read_text(encoding='utf-8'))['items']
        return next(item['stage'] for item in items if str(item['id']) == str(row))
    except (OSError, UnicodeError, ValueError, KeyError, TypeError, StopIteration) as error:
        print(f'lat-dispatch: warning: cannot read the stage of ledger row {row} in {ledger} '
              f'({error!r}); the brief carries no spec coverage section', file=sys.stderr)
        return None


def close_card(args):
    """Set status and deliverable commit, move the card to done/ and update its ledger row.
    The new card is written first, the ledger row changes next and the original card is removed
    last, so a failure at any step leaves the card and the ledger as they were (the ledger is
    touched only after the steps most likely to fail have passed)."""
    path = Path(args.card).resolve()
    deliverable = single_line('--deliverable', args.deliverable)
    if not deliverable:
        raise Failure('--deliverable must not be empty')
    if path.parent.name == 'done':
        raise Failure(f'card is already in done/: {path}')
    target = path.parent / 'done' / path.name
    if target.exists():
        raise Failure(f'{target} already exists; nothing changed')
    try:
        text = path.read_text(encoding='utf-8')
    except (OSError, UnicodeError) as error:
        raise Failure(f'task card unreadable: {error}') from error
    values = {'status': args.status, 'deliverable commit': deliverable}
    lines, row = text.splitlines(keepends=True), None
    for index, line in enumerate(lines):
        match = CARD_FIELD.fullmatch(line.strip())
        key = match.group(1).strip() if match else None
        if key == 'ledger row':
            row = LEDGER_ROW.fullmatch(match.group(2).strip())
            if not row:
                raise Failure(f'task card ledger row is not "<number> (<ledger path>)": '
                              f'{match.group(2).strip()!r}; nothing changed')
        if key in values:
            ending = '\n' if line.endswith('\n') else ''
            lines[index] = f'- {key}：{values.pop(key)}{ending}'
    if values:
        raise Failure(f'task card lacks the {" and ".join(values)} field; nothing changed')
    if args.merged_into and args.status != 'merged':
        raise Failure('--merged-into needs --status merged; nothing changed')
    if row and args.status == 'merged' and not args.merged_into:
        raise Failure('--status merged on a card with a ledger row needs --merged-into <long-lived '
                      'branch holding the work>; nothing changed')
    if not os.access(path.parent, os.W_OK):
        raise Failure(f'{path.parent} is not writable; nothing changed')
    by = ['--by', args.by] if args.by else []
    if row:
        number, ledger = row.groups()
        try:
            shown = json.loads(run_ledger(args, 'show', '--ledger', ledger, '--json'))
            state = next(item['status'] for item in shown['items'] if str(item['id']) == number)
        except (Failure, ValueError, KeyError, TypeError, StopIteration) as error:
            raise Failure(f'cannot read ledger row {number} in {ledger} ({error}); '
                          'nothing changed') from None
        if state not in ('done', 'cancelled'):
            raise Failure(
                f'ledger row {number} is still {state}; close it first so the row and the card '
                f'agree: the implementer runs `lat-ledger.py done {number} --ledger {ledger} '
                f'--by <agent> --commit … --gate …`, or the orchestrator runs it with '
                f'`--by <orchestrator>`; nothing changed')

    def point_ledger_at(card):
        number, ledger = row.groups()
        run_ledger(args, 'update', number, '--ledger', ledger, *by, '--card', str(card))

    def close_ledger_row(card):
        number, ledger = row.groups()
        merged = ['--merged-into', args.merged_into] if args.merged_into else []
        run_ledger(args, 'update', number, '--ledger', ledger, *by, '--card', str(card), *merged)

    def ledger_points_to():
        number, ledger = row.groups()
        shown = json.loads(run_ledger(args, 'show', '--ledger', ledger, '--json'))
        return next((item.get('card') for item in shown['items'] if str(item['id']) == number),
                    None)

    def put_ledger_back(reason):
        """Point the row at the original card again unless it already does."""
        number, ledger = row.groups()
        fix = shlex.join(['lat-ledger.py', 'update', number, '--ledger', ledger, '--card',
                          str(path)])
        try:
            if ledger_points_to() not in (None, str(path)):
                point_ledger_at(path)
        except (Failure, ValueError, KeyError, TypeError) as error:
            target.unlink(missing_ok=True)
            raise Failure(f'{reason}; the ledger row could not be put back ({error}); '
                          f'the original card is untouched, fix the row with: {fix}') from None

    try:
        target.parent.mkdir(exist_ok=True)
        stream = open(target, 'x', encoding='utf-8')
    except OSError as error:
        raise Failure(f'card not closed: {error}') from error
    try:
        with stream:
            stream.write(''.join(lines))
    except OSError as error:
        target.unlink(missing_ok=True)
        raise Failure(f'card not closed: {error}') from error
    try:
        if row:
            close_ledger_row(target)
    except Failure as error:
        put_ledger_back(str(error))
        target.unlink(missing_ok=True)
        raise
    try:
        path.unlink()
    except OSError as error:
        if row:
            put_ledger_back(f'card not closed: {error}')
        target.unlink(missing_ok=True)
        raise Failure(f'card not closed: {error}') from error
    print(target)


def build_parser():
    parser = argparse.ArgumentParser(description='LAT dispatch helper')
    commands = parser.add_subparsers(dest='command', required=True)
    card = commands.add_parser('card', help='Create the task card for a launched HCOM tag '
                                         '(`card close` ends one: see card close --help)')
    card.add_argument('--tag', required=True)
    card.add_argument('--agent', help='HCOM name (full or base); picks one agent when the tag '
                      'matches several')
    card.add_argument('--before-launch', action='store_true',
                      help='make the card before the agent is launched; the agent field reads '
                           f'{PENDING} until the agent runs `card bind` (see card bind --help)')
    card.add_argument('--native', action='store_true',
                      help='Claude built-in agent without an HCOM name: --agent is its name, '
                           'kept as given')
    card.add_argument('--tasks', type=Path, required=True,
                      help='shared task-card directory (<workspace>/.lat/tasks)')
    card.add_argument('--orchestrator', required=True,
                      help='HCOM name of the orchestrator, written as the full name')
    card.add_argument('--live-actions', required=True)
    card.add_argument('--preflight', required=True)
    card.add_argument('--visual-acceptance', required=True,
                      help='what to look at, what to compare with, what counts as wrong; '
                           '無 when nothing visible changes')
    card.add_argument('--date', help='YYYY-MM-DD; default today')
    for option in ('model', 'branch', 'worktree', 'base-commit', 'owned-resources',
                   'expected-checks', 'full-suite', 'runs', 'temp-paths', 'next-step'):
        card.add_argument(f'--{option}', default=NONE)
    card.add_argument('--ledger', type=Path,
                      help='absolute path of the work ledger; adds and assigns a row for this card. '
                           'Needs --ticket, --stage and --evidence together')
    card.add_argument('--ticket', help='ledger row: ticket')
    card.add_argument('--title', help="ledger row: what the ticket solves; without it a "
                      "numbered ticket's tracker title is read once")
    stages = ', '.join(load_script('lat-ledger').STAGES)
    card.add_argument('--stage', help=f'ledger row: stage, one of {stages} (implement is accepted '
                                      'as impl)')
    card.add_argument('--evidence', action='append',
                      help='ledger row: evidence kinds (commit, gate, file); comma-separated or repeated')
    card.add_argument('--deadline', help='ignored (kept for older callers): the ledger keeps '
                      'the deadline at the estimate + 1h')
    card.add_argument('--depends', help='ledger row: comma-separated item numbers it waits for')
    card.add_argument('--repo', help='ledger row: absolute path of the local git checkout the commit evidence lives '
                      'in (not owner/repo)')
    card.add_argument('--tiny', action='store_true',
                      help='ledger row: put the ticket on the tiny-change lane; needs both '
                      "--no-feature and --no-format-change, the orchestrator's declarations")
    card.add_argument('--no-feature', action='store_true',
                      help='with --tiny: declare the change adds no feature')
    card.add_argument('--no-format-change', action='store_true',
                      help='with --tiny: declare the change keeps every data and storage format')
    card.add_argument('--old-round', action='store_true',
                      help="ledger row: add it to an earlier round's ledger on purpose "
                      '(lat-ledger.py add --old-round)')
    card.add_argument('--lat-dir', type=Path, default=LAT_DIR,
                      help='LAT skill directory holding scripts/lat-ledger.py')
    close = commands.add_parser('card-close', prog='lat-dispatch.py card close',
                                help='Close a card: status, deliverable, move to done/, ledger row')
    close.add_argument('--card', type=Path, required=True)
    close.add_argument('--status', required=True, choices=CLOSE_STATUSES)
    close.add_argument('--deliverable', required=True, help='commit or evidence text, written to the card as given')
    close.add_argument('--merged-into', help='with --status merged: the long-lived branch holding '
                       'the work (e.g. dev); refused if the row\'s commits are not on it')
    close.add_argument('--by', help='actor recorded in the ledger (default: lat-ledger.py\'s own default)')
    close.add_argument('--lat-dir', type=Path, default=LAT_DIR,
                       help='LAT skill directory holding scripts/lat-ledger.py')
    bind = commands.add_parser('card-bind', prog='lat-dispatch.py card bind',
                               help='Bind a --before-launch card to the launched agent')
    bind.add_argument('--card', type=Path, required=True)
    bind.add_argument('--agent', help='HCOM name of the agent carrying the card\'s tag; default '
                                      '$HCOM_INSTANCE_NAME, which must carry that tag ($HCOM_TAG)')
    bind.add_argument('--lat-dir', type=Path, default=LAT_DIR,
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
    argv = sys.argv[1:]
    if argv[:2] in (['card', 'close'], ['card', 'bind']):  # `card` itself has required options
        argv = [f'card-{argv[1]}', *argv[2:]]
    args = build_parser().parse_args(argv)
    try:
        {'card': make_card, 'card-close': close_card, 'card-bind': bind_card,
         'brief': make_brief}[args.command](args)
    except (Failure, ValueError, OSError) as error:
        print(f'lat-dispatch: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

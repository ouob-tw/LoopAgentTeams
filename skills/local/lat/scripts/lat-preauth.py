#!/usr/bin/env python3
"""LAT pre-authorization lookup (stdlib only).

Three layers say which actions the controller may take without asking: global
($XDG_CONFIG_HOME/lat/preauth.toml), project (the main checkout's .lat/preauth.toml) and
controller (the `preauth` field of this round's session record). Each key is read from the
narrowest layer that sets it: controller > project > global. `check` answers allow or ask for
one action after the fixed conditions the tool enforces (branch list, the full-suite gate's
passing records, which tickets the unpushed commits belong to, main checkout at the
integration branch's tip); `show` prints the effective settings and where each value came
from. Any unreadable or unknown setting makes every check ask. The tool never runs the action
itself.
"""
import argparse
from dataclasses import dataclass, field
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lat_common import shared_lat_dir

LAYERS = ('controller', 'project', 'global')  # narrowest first
ACTIONS = {'merge': 'merge into the integration branch', 'push': 'push to the remote',
           'deploy-test': 'deploy to the test environment',
           'deploy-prod': 'deploy to production',
           'install-host': "update the host's installed skills and hooks"}
# Not actions: no setting can pre-authorize these, so naming one always asks.
ALWAYS_ASK = {'change-acceptance': 'changing or cutting confirmed acceptance criteria',
              'spend': 'spending money or account quota',
              'delete-user-data': "deleting the user's data or shredding it",
              'new-ticket': 'opening new tickets that widen the work'}
ACTION_KEYS = {'allow': bool, 'branches': list, 'target': str, 'source': str}
ADVISOR_KEYS = {'extended': bool, 'may_settle': list, 'must_ask': list, 'source': str}
TOP_KEYS = {'version', 'experiment', 'actions', 'advisor', 'integration_branch'}
VERSION = 1
BRANCH_ACTIONS = ('merge', 'push')
MAIN_CHECKOUT_ACTIONS = ('deploy-test', 'deploy-prod', 'install-host')
GATE_ACTIONS = ('push', *MAIN_CHECKOUT_ACTIONS)
SUITE_GATE = Path(__file__).resolve().parents[2] / 'three-tier-testing/scripts/suite-gate.py'
ISSUE_REF = re.compile(r'(?<![\w&/])(?:[\w.-]+/[\w.-]+)?#(\d+)\b')
LISTED_COMMITS = 20  # an ask lists at most this many unpushed commits
SESSION_ENVS = ('CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID')
ENDED = ('ended', 'completed', 'cancelled')


@dataclass
class Layer:
    name: str
    location: str
    data: dict = field(default_factory=dict)
    present: bool = False
    note: str = ''  # why the layer does not apply, when it does not


def git(workspace, *args):
    result = subprocess.run(['git', '-C', str(workspace), *args], capture_output=True,
                            text=True, timeout=30)
    return result.stdout.strip() if result.returncode == 0 else None


def global_path():
    base = os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
    return Path(base) / 'lat' / 'preauth.toml'


def validate(data, where):
    """Problems with one layer's settings; an empty list means every key is known."""
    problems = []
    for key in data.keys() - TOP_KEYS:
        problems.append(f'{where}: unknown key `{key}`')
    if 'version' in data and (type(data['version']) is not int or data['version'] != VERSION):
        problems.append(f'{where}: version must be {VERSION}')
    if 'experiment' in data and not isinstance(data['experiment'], bool):
        problems.append(f'{where}: experiment must be true or false')
    if 'integration_branch' in data and (not isinstance(data['integration_branch'], str)
                                         or not data['integration_branch'].strip()):
        problems.append(f'{where}: integration_branch must be a branch name')
    actions = data.get('actions', {})
    if not isinstance(actions, dict):
        return [*problems, f'{where}: [actions] must be a table']
    for name, section in actions.items():
        if name in ALWAYS_ASK:
            problems.append(f'{where}: [actions.{name}] is never pre-authorized '
                            f'({ALWAYS_ASK[name]})')
        elif name not in ACTIONS:
            problems.append(f'{where}: unknown action [actions.{name}]')
        else:
            problems += section_problems(section, ACTION_KEYS, f'{where} [actions.{name}]')
    if 'advisor' in data:
        problems += section_problems(data['advisor'], ADVISOR_KEYS, f'{where} [advisor]')
    return problems


def section_problems(section, keys, where):
    if not isinstance(section, dict):
        return [f'{where}: must be a table']
    problems = []
    for key, value in section.items():
        kind = keys.get(key)
        if kind is None:
            problems.append(f'{where}: unknown key `{key}`')
        elif not isinstance(value, kind) or (
                kind is list and not all(isinstance(item, str) for item in value)):
            expected = {bool: 'true or false', list: 'a list of strings', str: 'a string'}[kind]
            problems.append(f'{where}: `{key}` must be {expected}')
    return problems


def file_layer(name, path):
    layer = Layer(name, str(path))
    try:
        text = path.read_text(encoding='utf-8')
    except FileNotFoundError:
        layer.note = 'no file'
        return layer, []
    except (OSError, UnicodeDecodeError) as error:
        return layer, [f'{name} layer {path}: unreadable ({error})']
    layer.present = True
    try:
        layer.data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        layer.data = {}
        return layer, [f'{name} layer {path}: malformed TOML ({error})']
    return layer, validate(layer.data, f'{name} layer {path}')


def controller_layer(workspace, session):
    """The `preauth` field of this round's session record; only an active round counts."""
    if not session:
        return Layer('controller', '(no session ID)', note='no session ID'), []
    if workspace is None:
        return Layer('controller', '(not in a Git repository)', note='no Git repository'), []
    path = shared_lat_dir(workspace) / 'sessions' / f'{session}.json'
    layer = Layer('controller', f'{path} `preauth`')
    try:
        record = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        layer.note = 'no session record'
        return layer, []
    except (OSError, ValueError) as error:
        return layer, [f'controller layer {path}: unreadable session record ({error})']
    if not isinstance(record, dict):
        return layer, [f'controller layer {path}: session record is not a JSON object']
    if record.get('status') != 'active':
        layer.note = f'session is {record.get("status") or "not active"}'
        return layer, []
    value = record.get('preauth')
    if value is None:
        layer.note = 'no `preauth` field'
        return layer, []
    history = record.get('history', [])
    if not isinstance(history, list) or not all(isinstance(item, dict) for item in history):
        return layer, [f'controller layer {path}: session `history` is not a list of objects']
    current = len(history) + 1
    round_number = value.get('round') if isinstance(value, dict) else None
    if (not isinstance(value, dict) or value.keys() != {'round', 'settings'}
            or not isinstance(value['settings'], dict)
            or type(round_number) is not int or round_number < 1):
        return layer, [f'controller layer {path}: `preauth` must hold exactly a positive '
                       'integer `round` and a `settings` table']
    if round_number != current:
        layer.note = f'written for round {value.get("round")}, this is round {current}'
        return layer, []
    layer.present, layer.data = True, value['settings']
    return layer, validate(layer.data, f'controller layer {path}')


def load_layers(workspace, session):
    """(layers narrowest first, problems). Problems make every check ask."""
    top = git(workspace, 'rev-parse', '--show-toplevel') if workspace else None
    top = Path(top) if top else None
    controller, problems = controller_layer(top, session)
    if top is None:
        project, more = Layer('project', '(not in a Git repository)', note='no Git repository'), []
    else:
        project, more = file_layer('project', shared_lat_dir(top) / 'preauth.toml')
    problems += more
    global_layer, more = file_layer('global', global_path())
    return [controller, project, global_layer], problems + more, top


def section(layer, path):
    value = layer.data
    for key in path:
        value = value.get(key) if isinstance(value, dict) else None
    return value if isinstance(value, dict) else None


def resolve(layers, path, keys):
    """{key: (value, layer name, layer's source)} taking each key from the narrowest layer."""
    effective = {}
    for key in keys:
        if key == 'source':
            continue
        for layer in layers:
            values = section(layer, path) if layer.present else None
            if values is not None and key in values:
                effective[key] = (values[key], layer.name, values.get('source'))
                break
    return effective


def action_settings(layers, action):
    """Effective keys of one action. Only the project knows what its test environment is,
    so `target` comes from the project layer alone."""
    effective = resolve(layers, ('actions', action), ACTION_KEYS)
    effective.pop('target', None)
    project = section(layers[1], ('actions', action)) if layers[1].present else None
    if project and 'target' in project:
        effective['target'] = (project['target'], 'project', project.get('source'))
    return effective


def origin(name, source):
    return f'{name}' + (f' (source {source})' if source else '')


def describe(key, value, name, source, path):
    return f'{key}={json.dumps(value, ensure_ascii=False)} from {origin(name, source)} [{path}]'


def main_checkout_problems(top, branch):
    """Deploy and install run only in the main checkout at the integration branch's tip."""
    if top is None:
        return ['not in a Git repository']
    reasons = []
    common = git(top, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    if common is None or Path(common).parent.resolve() != top.resolve():
        reasons.append(f'{top} is not the main checkout')
    if not branch:
        return reasons + ['integration branch unknown (the round ledger names none and no '
                          'layer sets integration_branch)']
    head = git(top, 'rev-parse', 'HEAD')
    tip = git(top, 'rev-parse', '--verify', '--quiet', f'refs/heads/{branch}')
    if tip is None:
        reasons.append(f'integration branch `{branch}` does not exist')
    elif head != tip:
        reasons.append(f'HEAD is not the tip of integration branch `{branch}`')
    return reasons


def round_ledger(top, session):
    """This round's ledger (the active session record's `ledger_path`) as a dict, or None."""
    if top is None or not session:
        return None
    try:
        record = json.loads((shared_lat_dir(top) / 'sessions' / f'{session}.json').read_text())
        if record.get('status') != 'active':
            return None
        ledger = json.loads(Path(record['ledger_path']).read_text())
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None
    return ledger if isinstance(ledger, dict) else None


def integration_branch(ledger, layers):
    """(branch, where it came from) or None: the round ledger's value when it names one,
    otherwise the narrowest layer's top-level `integration_branch`."""
    branch = ledger.get('integration_branch') if ledger else None
    if isinstance(branch, str) and branch:
        return branch, 'the round ledger'
    for layer in layers:
        if layer.present and 'integration_branch' in layer.data:
            return layer.data['integration_branch'], f'{layer.name} integration_branch'
    return None


def round_tickets(ledger):
    """Issue numbers of the tickets in the round ledger."""
    items = ledger.get('items') if ledger else None
    numbers = set()
    for item in items if isinstance(items, list) else []:
        ticket = item.get('ticket') if isinstance(item, dict) else None
        found = re.fullmatch(r'\s*(?:[\w.-]+/[\w.-]+)?#?(\d+)\s*', str(ticket or ''))
        if found:
            numbers.add(found[1])
    return numbers


def unpushed_commit_problems(top, version, ledger):
    """Commits the remotes lack must each reference only tickets of this round's ledger."""
    if ledger is None:
        return ['no active round ledger to tell whose tickets the unpushed commits belong to']
    tickets = round_tickets(ledger)
    log = git(top, 'log', '--format=%H%x1f%s%x1f%B%x1e', version, '--not', '--remotes')
    if log is None:
        return [f'cannot list the commits the remotes lack for {version[:12]}']
    foreign = []
    for entry in filter(None, (part.strip('\n') for part in log.split('\x1e'))):
        sha, subject, body = entry.split('\x1f', 2)
        refs = set(ISSUE_REF.findall(body))
        if not refs:
            foreign.append(f'{sha[:12]} "{subject}" (no ticket)')
        elif refs - tickets:
            others = ', '.join(f'#{number}' for number in sorted(refs - tickets, key=int))
            foreign.append(f'{sha[:12]} "{subject}" ({others})')
    if not foreign:
        return []
    listed = foreign[:LISTED_COMMITS]
    if len(foreign) > len(listed):
        listed.append(f'and {len(foreign) - len(listed)} more')
    return ['unpushed commits outside this round\'s tickets '
            f'({", ".join(sorted(tickets, key=int)) or "none"}): ' + '; '.join(listed)]


def load_suite_gate():
    spec = importlib.util.spec_from_file_location('suite_gate', SUITE_GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def gate_problems(top, version):
    """Every registered full suite needs a passing record for the version's content: the
    suite gate's own pre-push check, which reads the gate's records and never runs a test."""
    try:
        gate = load_suite_gate()
        lacking = gate.lacking_full_suites(top, version, gate.load_registry(top) or {})
    except (OSError, RuntimeError, ValueError) as error:
        return [f'full-suite gate check failed: {error}']
    return [f'no passing full-suite record for {version[:12]}: {suite["command"]} '
            f'(in {suite["cwd"]})' for suite in lacking]


def resolve_version(top, ref):
    return git(top, 'rev-parse', '--verify', '--quiet', f'{ref}^{{commit}}') if top else None


def evaluate(action, *, branch=None, commit=None, workspace=None, session=None):
    """The check's verdict as a dict: verdict, action, target, basis lines, reasons."""
    workspace = Path(workspace or Path.cwd())
    session = session or next((os.environ[key] for key in SESSION_ENVS if os.environ.get(key)),
                              None)
    target = ' '.join(part for part in (branch, commit) if part)
    result = dict(verdict='ask', action=action, target=target, basis=[], reasons=[])
    if action in ALWAYS_ASK:
        result['reasons'].append(f'always ask: {ALWAYS_ASK[action]}; no setting can '
                                 'pre-authorize it')
        return result
    if action not in ACTIONS:
        result['reasons'].append(f'unknown action `{action}`; known: {", ".join(ACTIONS)}')
        return result
    layers, problems, top = load_layers(workspace, session)
    if problems:
        result['reasons'] += problems
        return result
    effective = action_settings(layers, action)
    label = f'actions.{action}'
    allow = effective.get('allow')
    if allow is None:
        result['reasons'].append(f'no layer sets {label}.allow')
    elif allow[0] is False:
        result['reasons'].append(f'{label}.allow=false from {origin(allow[1], allow[2])}')
    else:
        result['basis'].append(describe('allow', *allow, label))
    if action in BRANCH_ACTIONS:
        branches = effective.get('branches')
        if not branch:
            result['reasons'].append('--branch is required for this action')
        elif branches is None:
            result['reasons'].append(f'no layer sets {label}.branches')
        elif branch not in branches[0]:
            result['reasons'].append(f'branch `{branch}` is not in {label}.branches '
                                     f'{json.dumps(branches[0])} from '
                                     f'{origin(branches[1], branches[2])}')
        else:
            result['basis'].append(describe('branches', *branches, label))
    ledger = round_ledger(top, session) if action in GATE_ACTIONS else None
    version = None
    if action in MAIN_CHECKOUT_ACTIONS:
        found = integration_branch(ledger, layers)
        result['reasons'] += main_checkout_problems(top, found and found[0])
        if found:
            result['basis'].append(f'integration branch `{found[0]}` from {found[1]}')
        version = resolve_version(top, 'HEAD')
        if commit and resolve_version(top, commit) != version:
            result['reasons'].append(f'commit `{commit}` is not HEAD')
    if action == 'deploy-test':
        found = effective.get('target')
        if found is None:
            result['reasons'].append('the project layer does not set actions.deploy-test.target')
        else:
            result['basis'].append(describe('target', *found, label))
    if action == 'push' and branch:
        version = resolve_version(top, commit or f'refs/heads/{branch}')
        if version is None:
            result['reasons'].append(f'cannot resolve the version to push '
                                     f'(`{commit or branch}`)')
        else:
            problems = unpushed_commit_problems(top, version, ledger)
            result['reasons'] += problems
            if not problems:
                result['basis'].append(f'every unpushed commit of {version[:12]} references '
                                       'only tickets of the round ledger')
    if action in GATE_ACTIONS and version:
        problems = gate_problems(top, version)
        result['reasons'] += problems
        if not problems:
            result['basis'].append(f'every registered full suite passed for {version[:12]}')
    if not result['reasons']:
        result['verdict'] = 'allow'
    return result


def verdict_line(result):
    head = f'{result["verdict"]} {result["action"]}' + (
        f' {result["target"]}' if result['target'] else '')
    if result['verdict'] == 'allow':
        return f'{head} — basis: ' + '; '.join(result['basis'])
    return f'{head} — reasons: ' + '; '.join(result['reasons'])


def cmd_check(args):
    result = evaluate(args.action, branch=args.branch, commit=args.commit,
                      workspace=args.workspace, session=args.session_id)
    print(json.dumps(result, ensure_ascii=False, indent=2) if args.json else verdict_line(result))
    return 0 if result['verdict'] == 'allow' else 1


def cmd_show(args):
    workspace = Path(args.workspace or Path.cwd())
    session = args.session_id or next(
        (os.environ[key] for key in SESSION_ENVS if os.environ.get(key)), None)
    layers, problems, _ = load_layers(workspace, session)
    lines = ['Layers (narrowest first):']
    for layer in layers:
        state = 'in effect' if layer.present else f'not in effect: {layer.note}'
        lines.append(f'  {layer.name}: {layer.location} ({state})')
    if problems:
        lines.append('Problems (every check asks until fixed):')
        lines += [f'  - {problem}' for problem in problems]
    lines.append('Effective settings:')
    found = integration_branch(None, layers)
    lines.append('  integration_branch = ' + (
        f'{json.dumps(found[0])}  ← {found[1].split()[0]} (the round ledger wins when it names '
        'one)' if found else '(not set; only the round ledger can name it)'))
    for name in ACTIONS:
        effective = action_settings(layers, name)
        lines.append(f'  [actions.{name}]' + ('' if effective else ' (not set; asks)'))
        lines += [f'    {key} = {json.dumps(value, ensure_ascii=False)}  ← {origin(layer, src)}'
                  for key, (value, layer, src) in effective.items()]
    effective = resolve(layers, ('advisor',), ADVISOR_KEYS)
    lines.append('  [advisor]' + ('' if effective else ' (not set)'))
    lines += [f'    {key} = {json.dumps(value, ensure_ascii=False)}  ← {origin(layer, src)}'
              for key, (value, layer, src) in effective.items()]
    print('\n'.join(lines))
    return 0


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--workspace', help='Git worktree to check from; default the current '
                                            'directory')
    common.add_argument('--session-id', help='controller session ID; default '
                                             '$CLAUDE_CODE_SESSION_ID, then $CODEX_THREAD_ID')
    parser = argparse.ArgumentParser(description='LAT pre-authorization lookup')
    commands = parser.add_subparsers(dest='command', required=True)
    sub = commands.add_parser('check', parents=[common], help='allow or ask for one action')
    sub.add_argument('--action', required=True, help=', '.join(ACTIONS))
    sub.add_argument('--branch', help='target branch (merge, push)')
    sub.add_argument('--commit', help='commit the action uses')
    sub.add_argument('--json', action='store_true')
    commands.add_parser('show', parents=[common],
                        help='effective settings and where each value came from')
    return parser


def main():
    args = build_parser().parse_args()
    try:
        return {'check': cmd_check, 'show': cmd_show}[args.command](args)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'lat-preauth: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())

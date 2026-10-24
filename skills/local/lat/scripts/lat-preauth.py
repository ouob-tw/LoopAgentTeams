#!/usr/bin/env python3
"""LAT pre-authorization lookup (stdlib only).

Three layers say which actions the controller may take without asking: global
($XDG_CONFIG_HOME/lat/preauth.toml), project (the main checkout's .lat/preauth.toml) and
controller (the `preauth` field of this round's session record). Each key is read from the
narrowest layer that sets it: controller > project > global. `check` answers allow or ask for
one action after the fixed conditions the tool enforces; `show` prints the effective settings
and where each value came from. Any unreadable or unknown setting makes every check ask.
`grant` writes one rule that a human-answered decision record names; `record` logs what was
done under pre-authorization and `report` lists this round's log for the delivery report.
The tool never runs the action itself.
"""
import argparse
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lat_common import shared_lat_dir, write_json_atomic, write_text_atomic
from lat_decision_status import read_decision_session, read_decision_status

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
TOP_KEYS = {'version', 'experiment', 'actions', 'advisor'}
VERSION = 1
BRANCH_ACTIONS = ('merge', 'push')
MAIN_CHECKOUT_ACTIONS = ('deploy-test', 'deploy-prod', 'install-host')
GATE_PENDING = 'full-suite gate check is not wired yet'
SESSION_ENVS = ('CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID')
ENDED = ('ended', 'completed', 'cancelled')
HUMAN_ANSWERED = ('answered', 'approved')
DECISION_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]*')
GRANT_KEYS = ('allow', 'branches')
RESULTS = ('succeeded', 'failed')
REPORT_GROUPS = (('auto', '依預先授權自動執行'), ('precedent', '引用舊答覆定案'),
                 ('bug-intake', '免確認開工'), ('grant', '設定寫入'))
ISO_TIME = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?')


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


def main_checkout_problems(top, ledger_branch):
    """Deploy and install run only in the main checkout at the integration branch's tip."""
    if top is None:
        return ['not in a Git repository']
    reasons = []
    common = git(top, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    if common is None or Path(common).parent.resolve() != top.resolve():
        reasons.append(f'{top} is not the main checkout')
    if not ledger_branch:
        return reasons + ['integration branch unknown (no active round ledger names one)']
    head = git(top, 'rev-parse', 'HEAD')
    tip = git(top, 'rev-parse', '--verify', '--quiet', f'refs/heads/{ledger_branch}')
    if tip is None:
        reasons.append(f'integration branch `{ledger_branch}` does not exist')
    elif head != tip:
        reasons.append(f'HEAD is not the tip of integration branch `{ledger_branch}`')
    return reasons


def integration_branch(top, session):
    """The integration branch named by this round's ledger, or None."""
    if top is None or not session:
        return None
    try:
        record = json.loads((shared_lat_dir(top) / 'sessions' / f'{session}.json').read_text())
        if record.get('status') != 'active':
            return None
        ledger = json.loads(Path(record['ledger_path']).read_text())
        branch = ledger.get('integration_branch')
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None
    return branch if isinstance(branch, str) and branch else None


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
    if action in MAIN_CHECKOUT_ACTIONS:
        result['reasons'] += main_checkout_problems(top, integration_branch(top, session))
    if action == 'deploy-test':
        found = effective.get('target')
        if found is None:
            result['reasons'].append('the project layer does not set actions.deploy-test.target')
        else:
            result['basis'].append(describe('target', *found, label))
    if action == 'push' or action in MAIN_CHECKOUT_ACTIONS:
        result['reasons'].append(GATE_PENDING)
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


class Refused(Exception):
    """The write was refused; nothing was changed."""


def session_of(args):
    return args.session_id or next(
        (os.environ[key] for key in SESSION_ENVS if os.environ.get(key)), None)


def current_round(args, *, active=True):
    """(top, session ID, session path, record, its bytes, round number) of this round."""
    workspace = Path(args.workspace or Path.cwd())
    top = git(workspace, 'rev-parse', '--show-toplevel')
    if not top:
        raise Refused(f'{workspace} is not in a Git repository')
    top, session = Path(top), session_of(args)
    if not session:
        raise Refused('no session ID (--session-id, $CLAUDE_CODE_SESSION_ID or $CODEX_THREAD_ID)')
    path = shared_lat_dir(top) / 'sessions' / f'{session}.json'
    try:
        original = path.read_bytes()
        record = json.loads(original)
    except FileNotFoundError:
        raise Refused(f'no session record {path}') from None
    except ValueError as error:
        raise Refused(f'unreadable session record {path} ({error})') from None
    history = record.get('history', []) if isinstance(record, dict) else None
    if not isinstance(history, list) or not all(isinstance(item, dict) for item in history):
        raise Refused(f'session record {path} is not an object with a list `history`')
    if active and record.get('status') != 'active':
        raise Refused(f'session {session} is {record.get("status") or "not active"}; '
                      'only an active round can write')
    return top, session, path, record, original, len(history) + 1


def records_path(top, session, round_number):
    return shared_lat_dir(top) / 'preauth-records' / f'{session}-r{round_number}.jsonl'


def append_record(top, session, round_number, entry):
    path = records_path(top, session, round_number)
    try:
        original = path.read_bytes()
    except FileNotFoundError:
        original = None
    entry = dict(at=datetime.now(timezone.utc).isoformat(timespec='seconds'), **entry)
    text = (original or b'').decode('utf-8') + json.dumps(entry, ensure_ascii=False) + '\n'
    write_text_atomic(path, text, expected=original)
    return path


def decision_path(top, record, decision):
    if not DECISION_ID.fullmatch(decision or ''):
        raise Refused(f'invalid decision record ID `{decision}`')
    directory = record.get('decisions_path')
    directory = Path(directory) if isinstance(directory, str) else shared_lat_dir(top) / 'decisions'
    return directory / f'{decision}.md'


def sections(text, heading):
    """Lines of every `## <heading>…` section, in order."""
    found, inside = [], False
    for line in text.splitlines():
        if line.startswith('## '):
            inside = line[3:].lstrip().startswith(heading)
            if inside:
                found.append([line])
            continue
        if inside:
            found[-1].append(line)
    return found


def human_answer_problems(path):
    """Why the decision record holds no human answer; an empty list means it does."""
    try:
        text = path.read_text(encoding='utf-8')
    except FileNotFoundError:
        return [f'decision record {path} not found'], ''
    except (OSError, UnicodeDecodeError) as error:
        return [f'decision record {path} unreadable ({error})'], ''
    problems = []
    status = read_decision_status(path)
    if status.error or status.status not in HUMAN_ANSWERED:
        problems.append(f'{path.stem} status is {status.status or status.error}, not '
                        f'{" or ".join(HUMAN_ANSWERED)}')
    if not any(re.match(r'^- 來源：\s*\S', line) for section in sections(text, '答覆')
               for line in section):
        problems.append(f'{path.stem} has no answer section with a `- 來源：` line')
    return problems, text


def grant_words(layer, action, values):
    words = [layer, action]
    for key in GRANT_KEYS:
        if key in values:
            value = values[key]
            words.append(f'{key}=' + (','.join(value) if isinstance(value, list)
                                      else 'true' if value is True else 'false'))
    return words


def parse_grant(line):
    """(layer, action, {key: value text}) from a `- grant:` line, or None if it repeats a key."""
    words = line.split(':', 1)[1].split()
    if len(words) < 2:
        return None
    pairs = [word.split('=', 1) if '=' in word else [word, None] for word in words[2:]]
    values = dict(pairs)
    return None if len(values) != len(pairs) else (words[0], words[1], values)


def grant_problems(text, layer, action, values):
    wanted = grant_words(layer, action, values)
    wanted = (wanted[0], wanted[1], dict(word.split('=', 1) for word in wanted[2:]))
    lines = [line for section in sections(text, '核准範圍') for line in section
             if re.match(r'^- grant:', line)]
    if not lines:
        return ['the approved-scope section (## 核准範圍) has no `- grant:` line']
    if any(parse_grant(line) == wanted for line in lines):
        return []
    return [f'no `- grant:` line matches `- grant: {" ".join(grant_words(layer, action, values))}`'
            f'; found: ' + ' | '.join(line.strip() for line in lines)]


def answer_times(text):
    times = []
    for section in sections(text, '答覆'):
        for match in ISO_TIME.findall(section[0]):
            moment = parse_time(match)
            if moment is not None:
                times.append(moment)
    return times


def parse_time(value):
    try:
        moment = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return moment if moment.tzinfo else None


def round_problems(text, path, session, record):
    """The controller layer only takes an answer given in this session's current round."""
    owner = read_decision_session(path)
    if owner != session:
        return [f'{path.stem} belongs to session {owner or "(none)"}, not this session {session}']
    history = record.get('history', [])
    if not history:
        return []
    ended = parse_time(str(history[-1].get('ended_at_utc', '')))
    if ended is None:
        return ['previous round has no readable ended_at_utc; cannot tell which round '
                f'{path.stem} was answered in']
    times = answer_times(text)
    if not times:
        return [f'{path.stem} answer heading has no time; cannot tell which round it was '
                'answered in']
    if max(times) <= ended:
        return [f'{path.stem} was answered in an earlier round (before {ended.isoformat()})']
    return []


def toml_value(value):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, list):
        return '[' + ', '.join(json.dumps(item, ensure_ascii=False) for item in value) + ']'
    return json.dumps(value, ensure_ascii=False)


TABLE_HEADER = re.compile(r'^\s*\[\s*([^\[\]]+?)\s*\]\s*(?:#.*)?$')


def edit_action_section(text, action, values):
    """Set `values` inside [actions.<action>] and leave every other byte of `text` alone."""
    lines = text.splitlines(keepends=True)
    names = (f'actions.{action}', f'actions."{action}"')
    start = next((index for index, line in enumerate(lines)
                  if (match := TABLE_HEADER.match(line)) and match[1] in names), None)
    assignments = {key: f'{key} = {toml_value(value)}\n' for key, value in values.items()}
    if start is None:
        prefix = text if not text or text.endswith('\n') else text + '\n'
        return (prefix + ('\n' if prefix.strip() else '') + f'[actions.{action}]\n'
                + ''.join(assignments.values()))
    end = next((index for index in range(start + 1, len(lines))
                if lines[index].lstrip().startswith('[')), len(lines))
    body = lines[start + 1:end]
    for key, assignment in assignments.items():
        pattern = re.compile(rf'^\s*{re.escape(key)}\s*=')
        index = next((i for i, line in enumerate(body) if pattern.match(line)), None)
        if index is None:
            last = max((i for i, line in enumerate(body)
                        if line.strip() and not line.lstrip().startswith('#')), default=-1)
            body.insert(last + 1, assignment)
            continue
        stop = index + 1
        if body[index].split('=', 1)[1].strip().startswith('[') and ']' not in body[index]:
            while stop < len(body) and ']' not in body[stop - 1]:
                stop += 1
        body[index:stop] = [assignment]
    return ''.join(lines[:start + 1] + body + lines[end:])


def write_file_layer(path, action, values):
    try:
        original = path.read_bytes()
    except FileNotFoundError:
        original = None
    try:
        text = (original or b'').decode('utf-8')
        data = tomllib.loads(text)
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise Refused(f'{path} is not readable TOML ({error}); fix it by hand first') from None
    if problems := validate(data, str(path)):
        raise Refused('; '.join(problems) + '; fix it by hand first')
    updated = edit_action_section(text, action, values)
    expected = json.loads(json.dumps(data))
    expected.setdefault('actions', {}).setdefault(action, {}).update(values)
    try:
        result = tomllib.loads(updated)
    except tomllib.TOMLDecodeError:
        result = None
    if result != expected or validate(result, str(path)):
        raise Refused(f'could not edit [actions.{action}] in {path} without touching other '
                      'settings; edit the file by hand')
    write_text_atomic(path, updated, expected=original)


def write_controller_layer(path, record, original, round_number, action, values):
    current = record.get('preauth')
    settings = (current['settings'] if isinstance(current, dict)
                and current.get('round') == round_number
                and isinstance(current.get('settings'), dict) else {})
    settings = json.loads(json.dumps(settings))
    settings.setdefault('actions', {}).setdefault(action, {}).update(values)
    if problems := validate(settings, f'controller layer {path}'):
        raise Refused('; '.join(problems))
    write_json_atomic(path, dict(record, preauth={'round': round_number, 'settings': settings}),
                      expected=original)


def cmd_grant(args):
    if args.action not in ACTIONS:
        raise Refused(f'`{args.action}` is not a pre-authorizable action; known: '
                      f'{", ".join(ACTIONS)}')
    values = {}
    if args.allow is not None:
        values['allow'] = args.allow == 'true'
    if args.branches:
        values['branches'] = args.branches
    if not values:
        raise Refused('nothing to write: give --allow and/or --branches')
    top, session, path, record, original, round_number = current_round(args)
    source = decision_path(top, record, args.source)
    problems, text = human_answer_problems(source)
    if text:
        problems += grant_problems(text, args.layer, args.action, values)
        if args.layer == 'controller':
            problems += round_problems(text, source, session, record)
    if problems:
        raise Refused('; '.join(problems))
    values['source'] = args.source
    if args.layer == 'controller':
        write_controller_layer(path, record, original, round_number, args.action, values)
        where = f'{path} `preauth`'
    else:
        target = global_path() if args.layer == 'global' else shared_lat_dir(top) / 'preauth.toml'
        write_file_layer(target, args.action, values)
        where = str(target)
    line = ' '.join(grant_words(args.layer, args.action, values))
    append_record(top, session, round_number,
                  dict(kind='grant', grant=line, source=args.source, file=where))
    print(f'granted {line} (source {args.source}) → {where}')
    return 0


def hcom_event(event_id):
    result = subprocess.run(['hcom', 'events', '--sql', f'id={event_id}', '--full', '--all',
                             '--last', '1'], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise Refused(f'hcom events failed: {(result.stderr or result.stdout).strip()}')
    for line in result.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get('id') == event_id:
            return event
    return None


def notice_problems(label, event_id, sender):
    """(problems, time) for one HCOM notice the controller says it sent."""
    event = hcom_event(event_id)
    if event is None:
        return [f'{label} notice #{event_id} not found in hcom events'], None
    data = event.get('data') if isinstance(event.get('data'), dict) else {}
    problems = []
    if event.get('type') != 'message':
        problems.append(f'{label} notice #{event_id} is not a message')
    if data.get('from') != sender:
        problems.append(f'{label} notice #{event_id} was sent by {data.get("from")}, not this '
                        f'controller {sender}')
    if data.get('scope') != 'mentions' or not data.get('mentions'):
        problems.append(f'{label} notice #{event_id} is a broadcast; address the other '
                        'controllers with @name')
    moment = parse_time(str(event.get('ts', '')))
    if moment is None:
        problems.append(f'{label} notice #{event_id} has no readable time')
    return problems, moment


def cmd_record(args):
    top, session, _, record, _, round_number = current_round(args)
    if args.kind == 'auto':
        entry = auto_entry(args, record)
    elif args.kind == 'precedent':
        missing = [flag for flag, value in (('--decision', args.decision),
                                             ('--source', args.source),
                                             ('--basis', args.basis)) if not value]
        if missing:
            raise Refused(f'a precedent record needs {", ".join(missing)}')
        cited = re.fullmatch(r'(\S+) r[1-9][0-9]*', args.source)
        if not cited:
            raise Refused('--source must be `<decision ID> r<version>` of the earlier answer')
        problems, _ = human_answer_problems(decision_path(top, record, cited[1]))
        if problems:
            raise Refused('; '.join(problems))
        entry = dict(kind='precedent', decision=args.decision, source=args.source,
                     basis=args.basis)
    else:
        conditions = dict(self_reported=args.self_reported, clear_expected=args.clear_expected,
                          single_ticket=args.single_ticket, restores_stated=args.restores_stated)
        missing = [f'--{key.replace("_", "-")}' for key, value in
                   dict(issue=args.issue, source=args.source, **conditions).items() if not value]
        if missing:
            raise Refused(f'a bug-intake record needs {", ".join(missing)}')
        entry = dict(kind='bug-intake', issue=args.issue, source=args.source, **conditions)
    path = append_record(top, session, round_number, entry)
    print(f'recorded {args.kind} → {path}')
    return 0


def auto_entry(args, record):
    if args.action not in ACTIONS:
        raise Refused(f'`{args.action}` is not a pre-authorizable action; known: '
                      f'{", ".join(ACTIONS)}')
    missing = [flag for flag, value in (('--commit', args.commit), ('--basis', args.basis),
                                         ('--result', args.result)) if not value]
    if missing:
        raise Refused(f'an auto record needs {", ".join(missing)}')
    entry = dict(kind='auto', action=args.action, target=args.branch, commit=args.commit,
                 basis=args.basis, result=args.result)
    if args.action not in MAIN_CHECKOUT_ACTIONS:
        return entry
    if args.notice_before is None or args.notice_after is None or not args.started:
        raise Refused(f'{args.action} needs --notice-before, --notice-after and --started')
    started = parse_time(args.started)
    if started is None:
        raise Refused('--started must be an ISO time with a time zone')
    sender = record.get('hcom_name')
    problems, before = notice_problems('before', args.notice_before, sender)
    more, after = notice_problems('after', args.notice_after, sender)
    problems += more
    if before and before >= started:
        problems.append(f'before notice #{args.notice_before} ({before.isoformat()}) is not '
                        f'earlier than --started {started.isoformat()}')
    if before and after and after <= before:
        problems.append(f'after notice #{args.notice_after} is not later than before notice '
                        f'#{args.notice_before}')
    if problems:
        raise Refused('; '.join(problems))
    return dict(entry, started=started.isoformat(), notice_before=args.notice_before,
                notice_after=args.notice_after)


def report_line(entry):
    kind = entry.get('kind')
    if kind == 'auto':
        head = ' '.join(str(part) for part in (entry.get('action'), entry.get('target'),
                                               entry.get('commit')) if part)
        notices = (f'；通知 #{entry["notice_before"]} → #{entry["notice_after"]}'
                   if 'notice_before' in entry else '')
        return f'- {head}：{entry.get("result")}；依據：{entry.get("basis")}{notices}'
    if kind == 'precedent':
        return (f'- {entry.get("decision")} 引用 {entry.get("source")}；依據：{entry.get("basis")}'
                '（建議寫成規則）')
    if kind == 'bug-intake':
        return (f'- {entry.get("issue")}；原訊息：{entry.get("source")}；本人回報：'
                f'{entry.get("self_reported")}；哪裡錯與應該怎樣：{entry.get("clear_expected")}；'
                f'一張票做得完：{entry.get("single_ticket")}；回到使用者說的樣子：'
                f'{entry.get("restores_stated")}')
    return f'- {entry.get("grant")}（source {entry.get("source")}）→ {entry.get("file")}'


def cmd_report(args):
    top, session, _, _, _, round_number = current_round(args, active=False)
    path = records_path(top, session, round_number)
    entries = []
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except FileNotFoundError:
        lines = []
    for number, line in enumerate(lines, 1):
        try:
            entry = json.loads(line)
        except ValueError:
            raise Refused(f'{path} line {number} is not JSON') from None
        entries.append(entry)
    out = [f'預先授權紀錄（session {session} 第 {round_number} 輪）']
    for kind, title in REPORT_GROUPS:
        out += ['', f'### {title}']
        out += [report_line(entry) for entry in entries if entry.get('kind') == kind] or ['- 無']
    print('\n'.join(out))
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
    sub = commands.add_parser('grant', parents=[common],
                              help='write one rule a human-answered decision record names')
    sub.add_argument('--layer', required=True, choices=('global', 'project', 'controller'))
    sub.add_argument('--action', required=True, help=', '.join(ACTIONS))
    sub.add_argument('--allow', choices=('true', 'false'))
    sub.add_argument('--branches', nargs='+', help='branch names')
    sub.add_argument('--source', required=True, help='decision record ID with the answer')
    sub = commands.add_parser('record', parents=[common],
                              help='log one thing done under pre-authorization')
    sub.add_argument('--kind', choices=('auto', 'precedent', 'bug-intake'), default='auto',
                     help='auto: an action done under pre-authorization (default); precedent: '
                          'settled by citing an earlier answer; bug-intake: a short-flow bug '
                          'ticket started without confirmation')
    sub.add_argument('--action', help='auto: ' + ', '.join(ACTIONS))
    sub.add_argument('--branch', help='auto: target branch')
    sub.add_argument('--commit', help='auto: commit the action used')
    sub.add_argument('--basis', help='auto: the check line; precedent: why it is the same kind')
    sub.add_argument('--result', choices=RESULTS, help='auto: how the action ended')
    sub.add_argument('--started', help='auto deploy/install: ISO time the action started')
    sub.add_argument('--notice-before', type=int, help='auto deploy/install: HCOM event ID of '
                                                       'the notice sent before starting')
    sub.add_argument('--notice-after', type=int, help='auto deploy/install: HCOM event ID of '
                                                      'the notice sent after finishing')
    sub.add_argument('--decision', help='precedent: the decision record settled')
    sub.add_argument('--source', help='precedent: `<ID> r<version>` of the earlier answer; '
                                      "bug-intake: where the user's own message is")
    sub.add_argument('--issue', help='bug-intake: the tracker issue opened')
    sub.add_argument('--self-reported', help='bug-intake: why the user reported it in person')
    sub.add_argument('--clear-expected', help='bug-intake: what is wrong and what it should be')
    sub.add_argument('--single-ticket', help='bug-intake: why one ticket finishes it')
    sub.add_argument('--restores-stated', help="bug-intake: why the fix only restores what the "
                                               'user described')
    commands.add_parser('report', parents=[common],
                        help="this round's records, grouped for the delivery report")
    return parser


def main():
    args = build_parser().parse_args()
    commands = {'check': cmd_check, 'show': cmd_show, 'grant': cmd_grant, 'record': cmd_record,
                'report': cmd_report}
    try:
        return commands[args.command](args)
    except Refused as error:
        print(f'lat-preauth: refused, nothing changed: {error}', file=sys.stderr)
        return 1
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'lat-preauth: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())

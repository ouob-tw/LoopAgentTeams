#!/usr/bin/env python3
"""LAT pre-authorization lookup (stdlib only).

Two layers say which actions the controller may take without asking: global
($XDG_CONFIG_HOME/lat/preauth.toml) and project (the main checkout's .lat/preauth.toml). Each key
is read from the narrowest layer that sets it: project > global. `target` comes from the project
layer alone and [advisor] from the global layer alone. `check` answers allow or ask for one action
after the action's time window, read against the current time, and the fixed conditions the tool
enforces (branch list, the full-suite gate's passing records,
which tickets the unpushed commits belong to, main checkout at the integration branch's tip).
`show` prints the effective settings and where each value came from. Any unreadable or unknown
setting makes every check ask. `grant` writes one rule that a human-answered decision record
names; `record` logs what was done under pre-authorization and `report` lists this round's log for
the delivery report. The board reads and writes settings through `board_settings` and `board_write`,
which the panel helper's `board preauth-read` and `board preauth-write` commands call. The tool never
runs the action itself.
"""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lat_common import hcom_send_name, run_cli, shared_lat_dir, write_text_atomic
from lat_decision_status import read_decision_status

ACTIONS = {'merge': 'merge into the integration branch', 'push': 'push to the remote',
           'deploy-test': 'deploy to the test environment',
           'deploy-prod': 'deploy to production',
           'install-host': "update the host's installed skills and hooks"}
# Not actions: no setting can pre-authorize these, so naming one always asks.
ALWAYS_ASK = {'change-acceptance': 'changing or cutting confirmed acceptance criteria',
              'spend': 'spending money or account quota',
              'delete-user-data': "deleting the user's data or shredding it",
              'new-ticket': 'opening new tickets that widen the work'}
# Each ask reason's kind. Only allow-false and condition leave nothing for an advisor to
# settle: a layer said no, or a condition the tool enforces does not hold.
REASON_KINDS = {'allow-false': 'a layer sets allow=false',
                'condition': 'a condition the tool enforces does not hold',
                'unset': 'no layer sets allow or branches',
                'always-ask': 'no setting can pre-authorize it',
                'error': 'the check could not judge it'}
USER_ONLY_KINDS = ('allow-false', 'condition')
ACTION_KEYS = {'allow': bool, 'branches': list, 'target': str, 'source': str, 'hours': str,
               'timezone': str}
ADVISOR_KEYS = {'extended': bool, 'may_settle': list, 'must_ask': list, 'source': str}
TOP_KEYS = {'version', 'actions', 'advisor', 'integration_branch'}
VERSION = 1
BRANCH_ACTIONS = ('merge', 'push')
MAIN_CHECKOUT_ACTIONS = ('deploy-test', 'deploy-prod', 'install-host')
GATE_ACTIONS = ('push', *MAIN_CHECKOUT_ACTIONS)
SUITE_GATE = Path(__file__).resolve().parents[2] / 'three-tier-testing/scripts/suite-gate.py'
ISSUE_REF = re.compile(r'(?<![\w&/])(?:([\w.-]+/[\w.-]+))?#(\d+)\b')
TRACKER_DOC = 'docs/agents/issue-tracker.md'
TRACKER_REPO = re.compile(r'gh issue\b[^`\n]*?(?<!\S)-R\s+([\w.-]+/[\w.-]+)')
SESSION_ENVS = ('CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID')
ENDED = ('ended', 'completed', 'cancelled')
HUMAN_ANSWERED = ('answered', 'approved')
# Older records head the answer section `## 真人答覆`.
ANSWER_HEADINGS = ('答覆', '真人答覆')
MUST_ASK_WORDS = ('spend', 'delete-user-data')
# Advisors may settle these within may_settle, so they only count when it is empty.
SETTLEABLE_WORDS = ('change-acceptance', 'new-ticket', 'scope-expansion')
DECISION_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]*')
GRANT_KEYS = ('allow', 'branches')
RESULTS = ('succeeded', 'failed')
REPORT_GROUPS = ((('auto',), '依預先授權自動執行'), (('bug-intake',), '免確認開工'),
                 (('grant', 'board'), '設定寫入'))
HOURS = re.compile(r'((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)')
# Long free text: written one item per line.
ADVISOR_LISTS = ('may_settle', 'must_ask')
BOARD_WRITES = 'preauth-writes.jsonl'


@dataclass
class Layer:
    name: str
    location: str
    data: dict = field(default_factory=dict)
    present: bool = False
    note: str = ''  # why the layer does not apply, when it does not
    sha256: str = ''  # of the bytes `data` was parsed from; a missing file hashes as empty
    problems: list = field(default_factory=list)


def git(workspace, *args):
    result = subprocess.run(['git', '-C', str(workspace), *args], capture_output=True,
                            text=True, timeout=30)
    return result.stdout.strip() if result.returncode == 0 else None


def current_time():
    return datetime.now(timezone.utc)


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
            problems += window_problems(section, f'{where} [actions.{name}]')
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


def content_hash(content):
    return hashlib.sha256(content or b'').hexdigest()


def known_zone(name):
    if name == 'localtime':  # the host's zone, not one written explicitly
        return False
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return False
    return True


def window_problems(section, where):
    """Problems with the time window keys one layer writes; a key the layer leaves out may come
    from another layer (window_gaps)."""
    if not isinstance(section, dict):
        return []
    problems = []
    hours, zone = section.get('hours'), section.get('timezone')
    if isinstance(hours, str):
        found = HOURS.fullmatch(hours)
        if not found or found[1] == found[2]:
            problems.append(f'{where}: `hours` must be "HH:MM-HH:MM" (24-hour) with different '
                            f'start and end, not {json.dumps(hours)}')
    if isinstance(zone, str) and not known_zone(zone):
        problems.append(f'{where}: `timezone` must be a time zone name such as "Asia/Taipei", '
                        f'not {json.dumps(zone)}')
    return problems


def in_window(hours, moment):
    """Whether the local time is in `hours`, start included and end excluded; a start later
    than the end runs across midnight."""
    start, end = hours.split('-')
    now = moment.strftime('%H:%M')
    return start <= now < end if start < end else now >= start or now < end


def file_layer(name, path):
    layer = Layer(name, str(path), sha256=content_hash(None))
    try:
        content = path.read_bytes()
        layer.sha256 = content_hash(content)
        text = content.decode('utf-8')
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


def load_layers(workspace):
    """([project layer, global layer], problems, Git top). Problems make every check ask."""
    top = git(workspace, 'rev-parse', '--show-toplevel') if workspace else None
    top = Path(top) if top else None
    if top is None:
        project = Layer('project', '(not in a Git repository)', note='no Git repository')
        problems = []
    else:
        project, problems = file_layer('project', shared_lat_dir(top) / 'preauth.toml')
    global_layer, more = file_layer('global', global_path())
    project.problems, global_layer.problems = problems, more
    layers = [project, global_layer]
    return layers, problems + more + window_gaps(layers), top


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
    project = section(layers[0], ('actions', action)) if layers[0].present else None
    if project and 'target' in project:
        effective['target'] = (project['target'], 'project', project.get('source'))
    return effective


def advisor_settings(layers):
    """Effective [advisor] keys. What advisors may settle is the user's own call across
    projects, so only the global layer counts."""
    return resolve(layers[1:], ('advisor',), ADVISOR_KEYS)


def window_gaps(layers):
    """Once the layers are merged, an action's window needs both `hours` and `timezone`."""
    problems = []
    for action in ACTIONS:
        effective = action_settings(layers, action)
        for key, other in (('hours', 'timezone'), ('timezone', 'hours')):
            if key in effective and other not in effective:
                problems.append(f'[actions.{action}]: `{key}` is set but no layer sets `{other}`')
    return problems


def origin(name, source):
    return f'{name}' + (f' (source {source})' if source else '')


def describe(key, value, name, source, path):
    return f'{key}={json.dumps(value, ensure_ascii=False)} from {origin(name, source)} [{path}]'


def main_checkout_problems(top, branch):
    """Deploy and install run only in the main checkout at the integration branch's tip.
    Each problem is a (kind, reason) pair; the kinds are REASON_KINDS."""
    if top is None:
        return [('error', 'not in a Git repository')]
    reasons = []
    common = git(top, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    if common is None or Path(common).parent.resolve() != top.resolve():
        reasons.append(('condition', f'{top} is not the main checkout'))
    if not branch:
        return reasons + [('condition', 'integration branch unknown (the round ledger names '
                                        'none and no layer sets integration_branch)')]
    head = git(top, 'rev-parse', 'HEAD')
    tip = git(top, 'rev-parse', '--verify', '--quiet', f'refs/heads/{branch}')
    if tip is None:
        reasons.append(('condition', f'integration branch `{branch}` does not exist'))
    elif head != tip:
        reasons.append(('condition', f'HEAD is not the tip of integration branch `{branch}`'))
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
    """The round ledger's tickets as {(repo or '', number)}; a bare number has no repo."""
    items = ledger.get('items') if ledger else None
    tickets = set()
    for item in items if isinstance(items, list) else []:
        ticket = item.get('ticket') if isinstance(item, dict) else None
        found = re.fullmatch(r'\s*(?:([\w.-]+/[\w.-]+)#|#)?(\d+)\s*', str(ticket or ''))
        if found:
            tickets.add(((found[1] or '').lower(), found[2]))
    return tickets


def ticket_name(ticket):
    return f'{ticket[0]}#{ticket[1]}' if ticket[0] else f'#{ticket[1]}'


def own_tracker(top):
    """The project's own tracker repo, lowercased: the one `-R owner/repo` that the `gh issue`
    commands in docs/agents/issue-tracker.md pass (`gh pr` ones may name the code repo). None
    when the file is missing or those commands name none or several."""
    if top is None:
        return None
    try:
        repos = {repo.lower() for repo in TRACKER_REPO.findall((top / TRACKER_DOC).read_text())}
    except (OSError, UnicodeDecodeError):
        return None
    return repos.pop() if len(repos) == 1 else None


def is_round_ticket(ref, tickets, own=None):
    """A reference names a round ticket with the same number and, when both name a repo, the
    same repo. A bare ledger number stands for the project's own tracker `own`; it also takes
    a qualified reference from a repo some qualified ledger ticket names, or from any repo
    when no ledger ticket names one."""
    repos = {repo for repo, _ in tickets if repo}
    return any(number == ref[1] and (
        repo == ref[0] if repo and ref[0] else
        not (ref[0] and repos and ref[0] not in repos and ref[0] != own))
        for repo, number in tickets)


def unpushed_commit_problems(top, version, ledger):
    """Commits the remotes lack must each reference only tickets of this round's ledger.
    Each problem is a (kind, reason) pair."""
    if ledger is None:
        return [('error',
                 'no active round ledger to tell whose tickets the unpushed commits belong to')]
    tickets, own = round_tickets(ledger), own_tracker(top)
    log = git(top, 'log', '--format=%H%x1f%s%x1f%B%x1e', version, '--not', '--remotes')
    if log is None:
        return [('error', f'cannot list the commits the remotes lack for {version[:12]}')]
    foreign = []
    for entry in filter(None, (part.strip('\n') for part in log.split('\x1e'))):
        sha, subject, body = entry.split('\x1f', 2)
        refs = {(repo.lower(), number) for repo, number in ISSUE_REF.findall(body)}
        others = sorted(ticket_name(ref) for ref in refs if not is_round_ticket(ref, tickets, own))
        if not refs:
            foreign.append(f'{sha[:12]} "{subject}" (no ticket)')
        elif others:
            foreign.append(f'{sha[:12]} "{subject}" ({", ".join(others)})')
    if not foreign:
        return []
    names = ', '.join(sorted(ticket_name(ticket) for ticket in tickets)) or 'none'
    return [('condition',
             f"unpushed commits outside this round's tickets ({names}): " + '; '.join(foreign))]


def load_suite_gate():
    spec = importlib.util.spec_from_file_location('suite_gate', SUITE_GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def gate_problems(top, version):
    """Every registered full suite needs a passing record for the version's content: the
    suite gate's own pre-push check, which reads the gate's records and never runs a test.
    Each problem is a (kind, reason) pair."""
    try:
        gate = load_suite_gate()
        lacking = gate.lacking_full_suites(top, version, gate.load_registry(top) or {})
    except (OSError, RuntimeError, ValueError) as error:
        return [('error', f'full-suite gate check failed: {error}')]
    return [('condition', f'no passing full-suite record for {version[:12]}: '
                          f'{suite["command"]} (in {suite["cwd"]})') for suite in lacking]


def install_gate_problems(top, version):
    """(problems, skill folders checked). Only the full suites inside the skill folders the
    installer would install count, judged by the same suite-gate code the installer uses: the
    latest run on the same folder content must have passed. Without skill folders every
    registered suite counts (gate_problems)."""
    try:
        gate = load_suite_gate()
        folders = list(gate.skill_folders(top).values())
        if not folders:
            return gate_problems(top, version), None
        _, lacking = gate.lacking_folder_suites(top, gate.load_registry(top) or {}, folders,
                                                version)
    except (OSError, RuntimeError, ValueError) as error:
        return [('error', f'full-suite gate check failed: {error}')], None
    why = {'failed': 'the latest run of this content failed', 'missing': 'no run of this content'}
    return [('condition', f'no passing full-suite record for {version[:12]}: '
                          f'{suite["command"]} (in {suite["cwd"]}; skill folder {folder}: '
                          f'{why[result]})')
            for folder, suite, result in lacking], folders


def resolve_version(top, ref):
    return git(top, 'rev-parse', '--verify', '--quiet', f'{ref}^{{commit}}') if top else None


def evaluate(action, *, branch=None, commit=None, workspace=None, session=None):
    """The check's verdict as a dict: verdict, action, target, basis lines, reasons, and
    reason_kinds giving each reason's kind (REASON_KINDS) in the same order."""
    workspace = Path(workspace or Path.cwd())
    session = session or next((os.environ[key] for key in SESSION_ENVS if os.environ.get(key)),
                              None)
    target = ' '.join(part for part in (branch, commit) if part)
    result = dict(verdict='ask', action=action, target=target, basis=[], reasons=[],
                  reason_kinds=[])

    def ask(kind, *reasons):
        result['reasons'] += reasons
        result['reason_kinds'] += [kind] * len(reasons)

    def ask_each(problems):
        for kind, reason in problems:
            ask(kind, reason)

    if action in ALWAYS_ASK:
        ask('always-ask', f'always ask: {ALWAYS_ASK[action]}; no setting can pre-authorize it')
        return result
    if action not in ACTIONS:
        ask('error', f'unknown action `{action}`; known: {", ".join(ACTIONS)}')
        return result
    layers, problems, top = load_layers(workspace)
    if problems:
        ask('error', *problems)
        return result
    effective = action_settings(layers, action)
    label = f'actions.{action}'
    allow = effective.get('allow')
    if allow is None:
        ask('unset', f'no layer sets {label}.allow')
    elif allow[0] is False:
        ask('allow-false', f'{label}.allow=false from {origin(allow[1], allow[2])}')
    else:
        result['basis'].append(describe('allow', *allow, label))
    hours = effective.get('hours')
    if hours:
        zone = effective['timezone']
        now = current_time().astimezone(ZoneInfo(zone[0]))
        window = (f'{label}.hours {hours[0]} from {origin(hours[1], hours[2])}, '
                  f'timezone {zone[0]} from {origin(zone[1], zone[2])}')
        if in_window(hours[0], now):
            result['basis'].append(f'now {now:%H:%M} is inside {window}')
        else:
            ask('condition', f'now {now:%H:%M} is outside {window}')
    if action in BRANCH_ACTIONS:
        branches = effective.get('branches')
        if not branch:
            ask('error', '--branch is required for this action')
        elif branches is None:
            ask('unset', f'no layer sets {label}.branches')
        elif branch not in branches[0]:
            ask('condition', f'branch `{branch}` is not in {label}.branches '
                             f'{json.dumps(branches[0])} from {origin(branches[1], branches[2])}')
        else:
            result['basis'].append(describe('branches', *branches, label))
    ledger = round_ledger(top, session) if action in GATE_ACTIONS else None
    version = None
    if action in MAIN_CHECKOUT_ACTIONS:
        found = integration_branch(ledger, layers)
        ask_each(main_checkout_problems(top, found and found[0]))
        if found:
            result['basis'].append(f'integration branch `{found[0]}` from {found[1]}')
        version = resolve_version(top, 'HEAD')
        if commit and resolve_version(top, commit) != version:
            ask('condition', f'commit `{commit}` is not HEAD')
    if action == 'deploy-test':
        found = effective.get('target')
        if found is None:
            ask('condition', 'the project layer does not set actions.deploy-test.target')
        else:
            result['basis'].append(describe('target', *found, label))
    if action == 'push' and branch:
        version = resolve_version(top, commit or f'refs/heads/{branch}')
        if version is None:
            ask('error', f'cannot resolve the version to push (`{commit or branch}`)')
        else:
            problems = unpushed_commit_problems(top, version, ledger)
            ask_each(problems)
            if not problems:
                result['basis'].append(f'every unpushed commit of {version[:12]} references '
                                       'only tickets of the round ledger')
    if action == 'install-host' and version:
        problems, folders = install_gate_problems(top, version)
        ask_each(problems)
        if not problems and folders:
            result['basis'].append(f'every full suite in the {len(folders)} skill folders '
                                   f'passed for {version[:12]}')
        elif not problems:
            result['basis'].append(f'every registered full suite passed for {version[:12]}')
    elif action in GATE_ACTIONS and version:
        problems = gate_problems(top, version)
        ask_each(problems)
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


def other_controllers(workspace, session):
    """(own HCOM name or None, HCOM names of the other active controllers) from the session
    records in the shared .lat directory."""
    own, others = None, []
    try:
        workspace = Path(workspace or Path.cwd())
        paths = sorted((shared_lat_dir(workspace) / 'sessions').glob('*.json'))
    except (OSError, ValueError):
        return own, others
    for path in paths:
        try:
            record = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        name = record.get('hcom_name') if isinstance(record, dict) else None
        if not isinstance(name, str) or not name:
            continue
        if path.stem == session:
            own = name
        elif record.get('status') == 'active' and name not in others:
            others.append(name)
    return own, [name for name in others if name != own]


def notice_steps():
    """The check's Next steps for an action that needs before and after notices. `notice`
    sends each one and prints its event id, which `record` accepts only if this controller sent
    it to named agents."""
    return ("Send the before-notice with `lat-preauth.py notice --text '<text>'` (it goes to the "
            'other live controllers of this session, or to `--to <name>…` to name others; never '
            'yourself, never a broadcast) and keep the event id it prints; with no other live '
            'controller it sends nothing and prints a `none-<n>` id; if it fails or prints no '
            'id, the notice was not sent: do not do the action. Note '
            '--started; do the action; send the after-notice the same way; then '
            'record --kind auto … --notice-before <id> --notice-after <id> --started <time>.')


def live_names(agents):
    return {item[key] for item in agents for key in ('name', 'base_name')
            if isinstance(item.get(key), str)}


def notice_agents():
    try:
        agents = json.loads(run_cli(['hcom', 'list', '--json'], timeout=30))
    except ValueError as error:
        raise Refused(f'HCOM could not be read, so no recipient is known to be live: {error}')
    if not isinstance(agents, list):
        raise Refused('HCOM could not be read, so no recipient is known to be live')
    if not all(isinstance(item, dict) and isinstance(item.get('name'), str) and item['name']
               for item in agents):
        raise Refused('HCOM could not be read, so no recipient is known to be live: '
                      'malformed agent list')
    return agents


def no_recipient_path(top, session, round_number):
    return shared_lat_dir(top) / 'preauth-records' / f'{session}-r{round_number}-no-recipient.jsonl'


def note_no_recipient(top, session, round_number, own, wanted, gone):
    """Log that `own` found no other live controller to notify and return the `none-<n>` id
    that `record` accepts in place of an HCOM event id."""
    path = no_recipient_path(top, session, round_number)
    try:
        original = path.read_bytes()
    except FileNotFoundError:
        original = None
    old = (original or b'').decode('utf-8')
    identifier = f'none-{len(old.splitlines()) + 1}'
    entry = dict(id=identifier, sender=own, recorded=wanted, not_live=gone,
                 self_names=[name for name in wanted if name not in gone],
                 at=datetime.now(timezone.utc).isoformat())
    write_text_atomic(path, old + json.dumps(entry, ensure_ascii=False) + '\n', expected=original)
    detail = f' (recorded but not live: {", ".join(gone)})' if gone else ''
    print(f'lat-preauth: no other live controller to notify{detail}; nothing sent',
          file=sys.stderr)
    return identifier


def cmd_notice(args):
    text = args.text.strip()
    if not text:
        raise Refused('the notice text is empty')
    own, others = other_controllers(args.workspace, session_of(args))
    if not own:
        raise Refused('this controller has no HCOM name in its session record, so the sender '
                      'is unknown')
    agents = notice_agents()
    sender = hcom_send_name(own, agents)
    live = live_names(agents)
    wanted = list(dict.fromkeys(args.to or others))
    gone = [name for name in wanted if name not in live]
    targets = [name for name in wanted if name in live and name not in (own, sender)]
    if args.to and gone:  # named on purpose, so no partial send
        raise Refused(f'not live on HCOM: {", ".join(gone)}')
    if not targets and args.to:
        raise Refused('no recipient is live on HCOM')
    if not targets:  # no other live controller: nobody to tell, so say so on the record
        top, session = round_owner(args)
        with locked(session_lock(top, session)):
            _, _, _, round_number = current_round(top, session)
            print(note_no_recipient(top, session, round_number, own, wanted, gone))
        return 0
    if gone:  # recorded controllers HCOM no longer has
        print(f'lat-preauth: not sent to {", ".join(gone)}: not live on HCOM', file=sys.stderr)
    started = datetime.now(timezone.utc)
    run_cli(['hcom', 'send', *(f'@{name}' for name in targets), '--intent', 'inform',
             '--name', own, '--', text], timeout=60, failure='hcom send failed')
    found = run_cli(['hcom', 'events', '--type', 'message', '--from', sender, '--full',
                     '--after', started.isoformat(), '--last', '200'], timeout=30)
    ids = []
    for line in found.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        data = event.get('data') if isinstance(event, dict) else None
        moment = parse_time(str(event.get('ts', ''))) if isinstance(event, dict) else None
        if (isinstance(data, dict) and moment and moment >= started
                and event.get('type') == 'message' and isinstance(event.get('id'), int)
                and data.get('from') == sender and data.get('scope') == 'mentions'
                and data.get('text') == text):
            ids.append(event['id'])
    if not ids:
        raise Refused('hcom send returned but the message was not found in hcom events; it may '
                      'not have been delivered')
    if len(ids) > 1:
        raise Refused(f'the same text was sent more than once since the send began '
                      f'({", ".join(map(str, ids))}); cannot tell which one is this notice')
    print(ids[0])
    return 0


def cmd_check(args):
    result = evaluate(args.action, branch=args.branch, commit=args.commit,
                      workspace=args.workspace, session=args.session_id)
    if result['verdict'] == 'allow' and args.action in MAIN_CHECKOUT_ACTIONS:
        result['next_steps'] = notice_steps()
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(verdict_line(result))
        if 'next_steps' in result:
            print('Next steps: ' + result['next_steps'])
    return 0 if result['verdict'] == 'allow' else 1


def cmd_show(args):
    layers, problems, _ = load_layers(Path(args.workspace or Path.cwd()))
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
    effective = advisor_settings(layers)
    lines.append('  [advisor]' + ('' if effective else ' (not set)'))
    lines += [f'    {key} = {json.dumps(value, ensure_ascii=False)}  ← {origin(layer, src)}'
              for key, (value, layer, src) in effective.items()]
    if layers[0].present and 'advisor' in layers[0].data:
        lines.append(f'    專案層的 [advisor] 不生效 ({layers[0].location})')
    print('\n'.join(lines))
    return 0


class Refused(Exception):
    """The write was refused; nothing was changed."""


class LayerInvalid(Refused):
    """The settings file already has errors; `problems` lists them."""

    def __init__(self, problems):
        super().__init__('; '.join(problems) + '; fix it by hand first')
        self.problems = problems


class Conflict(Refused):
    """The settings file is not the one the writer read."""


def session_of(args):
    return args.session_id or next(
        (os.environ[key] for key in SESSION_ENVS if os.environ.get(key)), None)


@contextmanager
def locked(lock_path):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def round_owner(args):
    """(top, session ID) the write belongs to."""
    workspace = Path(args.workspace or Path.cwd())
    top = git(workspace, 'rev-parse', '--show-toplevel')
    if not top:
        raise Refused(f'{workspace} is not in a Git repository')
    top, session = Path(top), session_of(args)
    if not session or not DECISION_ID.fullmatch(session):
        raise Refused('no valid session ID (--session-id, $CLAUDE_CODE_SESSION_ID or '
                      '$CODEX_THREAD_ID)')
    return top, session


def session_lock(top, session):
    """The lock lat-session holds while it changes this session record (deactivate)."""
    return shared_lat_dir(top) / 'watch' / f'{session}.lock'


def current_round(top, session, *, active=True):
    """(session path, record, its bytes, round number) of this round; hold session_lock."""
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
    return path, record, original, len(history) + 1


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


def restore(path, original, written):
    """Undo one write of ours; `original` None means the file did not exist."""
    if original is None:
        if path.read_bytes() != written:
            raise ValueError(f'{path} changed after our write')
        path.unlink()
    else:
        write_text_atomic(path, original.decode('utf-8'), expected=written)


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


def answer_names_revision(section, revision, record_revision):
    """Whether an answer section answers `revision`. One whose heading and question line name
    no version answers `record_revision`, a list of at most one."""
    named = [line for line in section
             if line.startswith('## ') or re.match(r'^- (題目|題目版本|題號版本|revision)[：:]', line)]
    versions = re.findall(r'(?<![0-9A-Za-z_-])r([1-9][0-9]*)(?![0-9A-Za-z_-])', '\n'.join(named))
    return revision in (versions or record_revision)


def prior_promise_problem(basis, decisions):
    """Why `<ID> r<N>` names no recorded human answer, or None when it does."""
    match = re.fullmatch(r'(\S+) r([1-9][0-9]*)', basis)
    if not match or not DECISION_ID.fullmatch(match[1]):
        return f'依據格式應為 `<待決 ID> r<版本>`：{basis}'
    path = Path(decisions) / f'{match[1]}.md'
    if not path.is_file():
        return f'{match[1]} 紀錄不存在'
    try:
        text = path.read_text(encoding='utf-8')
    except (OSError, UnicodeDecodeError) as error:
        return f'{match[1]} 紀錄讀不出（{error}）'
    # A pending record was reopened at a new version, so a section naming no version answers
    # an earlier one that it cannot tell.
    record_revision = ([] if read_decision_status(path).status == 'pending' else
                       re.findall(r'^- version:\s*r([0-9]+)\b', text, re.MULTILINE | re.IGNORECASE)[:1])
    if not any(re.match(r'^- 來源：\s*\S', line)
               and answer_names_revision(section, match[2], record_revision)
               for heading in ANSWER_HEADINGS for section in sections(text, heading)
               for line in section):
        return f'{match[1]} 沒有 r{match[2]} 的真人答覆（`## 答覆` 段落與 `- 來源：` 行）'
    return None


def must_ask_problem(basis):
    """`(error, warning)` for a must-ask basis against the global [advisor] section, which is
    the only layer that counts; settings that cannot be read only warn."""
    if basis in MUST_ASK_WORDS:
        return None, None
    layers = load_layers(None)[0]
    if layers[1].problems:
        return None, '；'.join(layers[1].problems)
    settings = advisor_settings(layers)
    if basis in SETTLEABLE_WORDS:
        if settings.get('may_settle', ([],))[0]:
            return f'全域 may_settle 不是空的，{basis} 可能由參謀定案，照常諮詢', None
        return None, None
    if basis in [item.strip() for item in settings.get('must_ask', ([],))[0]]:
        return None, None
    return f'依據不在全域 must_ask 內，也不是 {"、".join(MUST_ASK_WORDS)}：{basis}', None


def exempt_basis_problem(category, basis, decisions):
    """`(error, warning)` for an exemption that needs a basis; both None when it holds."""
    if not basis:
        return '缺依據行（- exempt-basis:）', None
    if category == 'prior-promise':
        return prior_promise_problem(basis, decisions), None
    return must_ask_problem(basis)


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


def parse_time(value):
    try:
        moment = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return moment if moment.tzinfo else None


def toml_value(value):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, list):
        return '[' + ', '.join(json.dumps(item, ensure_ascii=False) for item in value) + ']'
    return json.dumps(value, ensure_ascii=False)


TABLE_HEADER = re.compile(r'^\s*\[\s*([^\[\]]+?)\s*\]\s*(?:#.*)?$')


def parses(text):
    try:
        tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return False
    return True


def assignment(key, value):
    if key in ADVISOR_LISTS:
        items = ''.join(f'  {toml_value(item)},\n' for item in value)
        return f'{key} = [\n{items}]\n'
    return f'{key} = {toml_value(value)}\n'


def line_comment(line):
    """The `# …` ending this line of TOML, outside any string; empty when it has none."""
    quote, escaped = None, False
    for index, char in enumerate(line):
        if escaped:
            escaped = False
        elif quote:
            escaped = char == '\\' and quote == '"'
            quote = None if char == quote else quote
        elif char in '"\'':
            quote = char
        elif char == '#':
            return line[index:].rstrip('\n')
    return ''


def replace_key(body, index, key, value):
    """Set or (value None) delete the key assigned at body[index]. A new one-line value keeps the
    comment closing its line; every comment inside a multi-line value moves above the key."""
    stop = next((stop for stop in range(index + 1, len(body) + 1)
                 if parses(''.join(body[index:stop]))), index + 1)
    new = []
    kept = [comment + '\n' for line in body[index:stop] if stop > index + 1
            and (comment := line_comment(line))]
    if value is not None:
        comment = line_comment(body[index]) if stop == index + 1 else ''
        new = [assignment(key, value)]
        if comment:
            new = [f'{new[0].rstrip()}  {comment}\n']
    body[index:stop] = [*kept, *new]


def edit_section(text, path, values):
    """Set `values` inside the table named by `path` and leave every other byte of `text` alone;
    a value of None deletes the key."""
    lines = text.splitlines(keepends=True)
    header = re.compile(r'\s*\.\s*'.join(
        rf"""(?:{re.escape(part)}|"{re.escape(part)}"|'{re.escape(part)}')""" for part in path))
    start = next((index for index, line in enumerate(lines)
                  if (match := TABLE_HEADER.match(line)) and header.fullmatch(match[1])), None)
    if start is None:
        prefix = text if not text or text.endswith('\n') else text + '\n'
        return (prefix + ('\n' if prefix.strip() else '') + f'[{".".join(path)}]\n'
                + ''.join(assignment(key, value) for key, value in values.items()
                          if value is not None))
    end = next((index for index in range(start + 1, len(lines))
                if lines[index].lstrip().startswith('[')), len(lines))
    body = lines[start + 1:end]
    for key, value in values.items():
        pattern = re.compile(rf'^\s*(?:{key}|"{key}"|\'{key}\')\s*=')
        index = next((i for i, line in enumerate(body) if pattern.match(line)), None)
        if index is not None:
            replace_key(body, index, key, value)
        elif value is not None:
            last = max((i for i, line in enumerate(body)
                        if line.strip() and not line.lstrip().startswith('#')), default=-1)
            if last >= 0 and not body[last].endswith('\n'):
                body[last] += '\n'  # the file's final line, written without a newline
            elif last < 0 and not lines[start].endswith('\n'):
                lines[start] += '\n'
            body.insert(last + 1, assignment(key, value))
    return ''.join(lines[:start + 1] + body + lines[end:])


def write_file_layer(path, edits, *, expected_sha256=None):
    """Apply {table path: {key: value or None}} to one settings file. (bytes before, bytes after).
    `expected_sha256` refuses a file other than the one the writer read."""
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
        raise LayerInvalid(problems)
    if expected_sha256 is not None and content_hash(original) != expected_sha256:
        raise Conflict(f'{path} changed after it was read')
    updated, expected = text, json.loads(json.dumps(data))
    for table, values in edits.items():
        updated = edit_section(updated, table, values)
        target = expected
        for part in table:
            target = target.setdefault(part, {})
        for key, value in values.items():
            if value is None:
                target.pop(key, None)
            else:
                target[key] = value
    try:
        result = tomllib.loads(updated)
    except tomllib.TOMLDecodeError:
        result = None
    if result != expected or validate(result, str(path)):
        names = ', '.join(f'[{".".join(table)}]' for table in edits)
        raise Refused(f'could not edit {names} in {path} without touching other settings; edit '
                      'the file by hand')
    return original, write_text_atomic(path, updated, expected=original)


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
    top, session = round_owner(args)
    target = global_path() if args.layer == 'global' else shared_lat_dir(top) / 'preauth.toml'
    # The session lock also serializes this round's log; the file lock covers other sessions.
    with locked(session_lock(top, session)), locked(target.with_name(f'.{target.name}.lock')):
        return grant_locked(args, top, session, target, values)


def grant_locked(args, top, session, target, values):
    _, record, _, round_number = current_round(top, session)
    source = decision_path(top, record, args.source)
    problems, text = human_answer_problems(source)
    if text:
        problems += grant_problems(text, args.layer, args.action, values)
    if problems:
        raise Refused('; '.join(problems))
    values['source'] = args.source
    before, written = write_file_layer(target, {('actions', args.action): values})
    line = ' '.join(grant_words(args.layer, args.action, values))
    try:
        append_record(top, session, round_number,
                      dict(kind='grant', grant=line, source=args.source, file=str(target)))
    except (OSError, ValueError) as error:
        # A grant that report cannot list must not stay in effect.
        try:
            restore(target, before, written)
        except (OSError, ValueError) as undo:
            raise ValueError(f'granted {line} to {target} but could not log it ({error}) nor '
                             f'undo it ({undo}); remove it by hand') from None
        raise ValueError(f'could not log the grant ({error}); {target} was restored') from None
    print(f'granted {line} (source {args.source}) → {target}')
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


def controller_senders(name):
    """The names HCOM may record for this controller's sends: the session record's name and,
    for a tagged instance, the base name `hcom list` gives it."""
    try:
        agents = json.loads(run_cli(['hcom', 'list', '--json'], timeout=30))
    except ValueError:
        return {name}
    if not isinstance(agents, list):
        return {name}
    return {name, hcom_send_name(name, [item for item in agents if isinstance(item, dict)])}


def notice_label(identifier):
    return identifier if isinstance(identifier, str) else f'#{identifier}'


def report_notice(identifier):
    return f'無人可通知（{identifier}，未發訊息）' if isinstance(identifier, str) else f'#{identifier}'


def notice_id(value):
    """An HCOM event ID, or the `none-<n>` id `notice` prints when no one was live."""
    if re.fullmatch(r'[0-9]+', value):
        return int(value)
    if re.fullmatch(r'none-[1-9][0-9]*', value):
        return value
    raise argparse.ArgumentTypeError(f'`{value}` is neither an HCOM event ID nor a none-<n> id')


def no_recipient_problems(label, identifier, top, session, round_number, sender, senders):
    """(problems, time) for a `none-<n>` id `notice` gave when no other controller was live."""
    try:
        lines = no_recipient_path(top, session, round_number).read_text(
            encoding='utf-8').splitlines()
    except OSError:
        lines = []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and entry.get('id') == identifier:
            moment = parse_time(str(entry.get('at', '')))
            recorded, not_live, mine = (entry.get(key) for key in
                                        ('recorded', 'not_live', 'self_names'))
            if (entry.get('sender') != sender or moment is None
                    or not all(isinstance(item, list) for item in (recorded, not_live, mine))
                    or not set(mine) <= senders or list(recorded) != [
                        name for name in recorded if name in not_live or name in mine]):
                break
            return [], moment
    return [f'{label} notice {identifier} was not issued by `notice` in this round'], None


def notice_problems(label, event_id, sender, senders):
    """(problems, time) for one HCOM notice the controller says it sent."""
    event = hcom_event(event_id)
    if event is None:
        return [f'{label} notice #{event_id} not found in hcom events'], None
    data = event.get('data') if isinstance(event.get('data'), dict) else {}
    problems = []
    if event.get('type') != 'message':
        problems.append(f'{label} notice #{event_id} is not a message')
    if data.get('from') not in senders:
        problems.append(f'{label} notice #{event_id} was sent by {data.get("from")}, not this '
                        f'controller {sender}')
    if data.get('scope') != 'mentions' or not data.get('mentions'):
        problems.append(f'{label} notice #{event_id} is a broadcast; address the other '
                        'controllers with @name')
    elif not data.get('delivered_to'):
        problems.append(f'{label} notice #{event_id} reached no one (delivered_to is empty); '
                        'send it to a live controller, or run `notice` again for the '
                        'no-one-to-notify result')
    moment = parse_time(str(event.get('ts', '')))
    if moment is None:
        problems.append(f'{label} notice #{event_id} has no readable time')
    return problems, moment


def cmd_record(args):
    top, session = round_owner(args)
    with locked(session_lock(top, session)):
        return record_locked(args, top, session)


def record_locked(args, top, session):
    _, record, _, round_number = current_round(top, session)
    if args.kind == 'auto':
        entry = auto_entry(args, record, top, session, round_number)
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


def auto_entry(args, record, top, session, round_number):
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
    senders = controller_senders(sender)

    def check(label, identifier):
        if isinstance(identifier, str):
            return no_recipient_problems(label, identifier, top, session, round_number, sender,
                                         senders)
        return notice_problems(label, identifier, sender, senders)

    problems, before = check('before', args.notice_before)
    more, after = check('after', args.notice_after)
    problems += more
    # Use the precision supplied by the caller, not the event store's microseconds.
    fraction = re.search(r'[Tt ]\d{2}:?\d{2}:?\d{2}[.,](\d+)', args.started)
    digits = min(len(fraction[1]), 6) if fraction else 0
    quantum = 10 ** (6 - digits)

    def at_started_precision(moment):
        return moment.replace(microsecond=moment.microsecond // quantum * quantum)

    if before and at_started_precision(before) > started:
        problems.append(f'before notice {notice_label(args.notice_before)} '
                        f'({before.isoformat()}) is later than --started {started.isoformat()} at its precision')
    if before and after and after <= before:
        problems.append(f'after notice {notice_label(args.notice_after)} is not later than '
                        f'before notice {notice_label(args.notice_before)}')
    if after and at_started_precision(after) <= started:
        problems.append(f'after notice {notice_label(args.notice_after)} ({after.isoformat()}) '
                        f'is not later than --started {started.isoformat()}')
    if problems:
        raise Refused('; '.join(problems))
    return dict(entry, started=started.isoformat(), notice_before=args.notice_before,
                notice_after=args.notice_after)


def report_line(entry):
    kind = entry.get('kind')
    if kind == 'auto':
        head = ' '.join(str(part) for part in (entry.get('action'), entry.get('target'),
                                               entry.get('commit')) if part)
        notices = (f'；通知 {report_notice(entry["notice_before"])} → '
                   f'{report_notice(entry["notice_after"])}'
                   if 'notice_before' in entry else '')
        return f'- {head}：{entry.get("result")}；依據：{entry.get("basis")}{notices}'
    if kind == 'bug-intake':
        return (f'- {entry.get("issue")}；原訊息：{entry.get("source")}；本人回報：'
                f'{entry.get("self_reported")}；哪裡錯與應該怎樣：{entry.get("clear_expected")}；'
                f'一張票做得完：{entry.get("single_ticket")}；回到使用者說的樣子：'
                f'{entry.get("restores_stated")}')
    if 'unreadable' in entry:
        return f'- 看板紀錄 {entry["unreadable"]} 讀不懂，可能漏列一筆'
    if kind == 'board':
        changes = '、'.join(change_text(change) for change in entry.get('changes', []))
        return f'- 看板 {entry.get("layer")}：{changes}（來源 board，{entry.get("at")}）→ {entry.get("file")}'
    return f'- {entry.get("grant")}（source {entry.get("source")}）→ {entry.get("file")}'


def cmd_report(args):
    top, session = round_owner(args)
    _, record, _, round_number = current_round(top, session, active=False)
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
    entries += board_writes_since(top, record)
    out = [f'預先授權紀錄（session {session} 第 {round_number} 輪）']
    for kinds, title in REPORT_GROUPS:
        out += ['', f'### {title}']
        out += [report_line(entry) for entry in entries if entry.get('kind') in kinds] or ['- 無']
    print('\n'.join(out))
    return 0


def board_writes_path():
    """The log of board writes, in the board's state folder because it spans projects."""
    state = os.environ.get('LAT_BOARD_STATE_DIR') or Path(
        os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state') / 'lat/board'
    return Path(state) / BOARD_WRITES


def board_writes_since(top, record):
    """Board writes to this project's and the global file since the round in `record` began; all
    of them when the record does not say when it began."""
    path = board_writes_path()
    files = (str(shared_lat_dir(top) / 'preauth.toml'), str(global_path()))
    since = parse_time(str(record.get('started_at_utc', '')))
    found = []
    try:
        lines = path.read_bytes().decode('utf-8', errors='replace').splitlines()
    except FileNotFoundError:
        return found
    for number, line in enumerate(lines, 1):
        try:
            entry = json.loads(line)
            moment = parse_time(entry['at'])
            if moment is None or not all({'section', 'key', 'value'} <= change.keys()
                                         for change in entry['changes']):
                raise ValueError('not a board write record')
        except (ValueError, KeyError, TypeError, AttributeError):
            # The log spans projects: one bad line must not take every project's report with it.
            found.append(dict(kind='board', unreadable=f'{path} 第 {number} 行'))
            continue
        if entry.get('file') in files and (since is None or moment >= since):
            found.append(entry)
    return found


def append_board_write(entry):
    path = board_writes_path()
    with locked(path.with_name(f'.{path.name}.lock')):
        try:
            original = path.read_bytes()
        except FileNotFoundError:
            original = None
        entry = dict(at=datetime.now(timezone.utc).isoformat(), kind='board', **entry)
        write_text_atomic(path, (original or b'').decode('utf-8')
                          + json.dumps(entry, ensure_ascii=False) + '\n', expected=original)


def change_text(change):
    head = f'[{change["section"]}] {change["key"]}'
    return f'{head} 移除' if change['value'] is None else f'{head} = {toml_value(change["value"])}'


def undo_lines(data, edits):
    """What to change by hand to put these edits back, given the settings before them."""
    lines = []
    for table, values in edits.items():
        before = data
        for part in table:
            before = before.get(part, {})
        for key in values:
            head = f'[{".".join(table)}] {key}'
            lines.append(f'{head} 改回 {toml_value(before[key])}' if key in before else f'{head} 移除')
    return lines


def board_view(layer):
    """One layer as the board edits it; no settings when its file has errors."""
    usable = layer.present and not layer.problems
    return dict(path=layer.location, exists=layer.present, sha256=layer.sha256,
                problems=layer.problems,
                actions={name: section(layer, ('actions', name)) or {} for name in ACTIONS}
                if usable else {},
                advisor=(section(layer, ('advisor',)) or {}) if usable else {})


def board_settings(workspace=None):
    """Each layer's own settings and the merged result; the project layer needs a workspace."""
    layers, problems, top = load_layers(workspace)
    def origin_of(found):
        return {key: dict(value=value, layer=name, source=source)
                for key, (value, name, source) in found.items()}

    views = dict(project=board_view(layers[0]), **{'global': board_view(layers[1])})
    if top is None:
        del views['project']
    # A file with errors makes every check ask, so nothing it says is in effect.
    return dict(status='ok', layers=views, problems=problems,
                effective=dict(actions={}, advisor={}) if problems else dict(
                    actions={name: origin_of(action_settings(layers, name)) for name in ACTIONS},
                    advisor=origin_of(advisor_settings(layers))),
                project_advisor=bool(layers[0].present and 'advisor' in layers[0].data))


def board_text(value, what):
    if not isinstance(value, str) or not value.strip():
        raise Refused(f'{what}不能是空白')
    return value.strip()


def board_list(value, what, *, single_word=False):
    if not isinstance(value, list):
        raise Refused(f'{what}必須是清單')
    items = [board_text(item, what) for item in value]
    if single_word and any(len(item.split()) > 1 for item in items):
        raise Refused(f'{what}不能有空白字元')
    return list(dict.fromkeys(items)) or None


def board_section_edits(current, wanted, cleaners, name):
    """{key: new value or None} for what `wanted` changes from `current`."""
    if not isinstance(wanted, dict):
        raise Refused(f'{name} 的改動格式不對')
    values = {}
    for key, value in wanted.items():
        if key not in cleaners:
            raise Refused(f'{name} 不能設定 {key}')
        value = None if value is None else cleaners[key](value)
        if value != current.get(key):
            values[key] = value
    return values


def board_allow(value):
    if type(value) is not bool:
        raise Refused('allow 必須是 true 或 false')
    return value


def board_target(value):
    if not isinstance(value, str):
        raise Refused('測試環境必須是文字')
    return value.strip() or None


def board_edits(layer, data, changes):
    """Turn the board's {actions: {name: {key: value or null}}, advisor: {…}} into edits holding
    only what differs from the file. It offers only what the board may set on this layer."""
    if not isinstance(changes, dict) or changes.keys() - {'actions', 'advisor'}:
        raise Refused('改動格式不對')
    edits = {}
    actions = changes.get('actions', {})
    if not isinstance(actions, dict):
        raise Refused('改動格式不對')
    for action, wanted in actions.items():
        if action not in ACTIONS:
            raise Refused(f'{action} 不能預先授權')
        cleaners = dict(allow=board_allow)
        if action in BRANCH_ACTIONS:
            cleaners['branches'] = lambda value: board_list(value, '分支名稱', single_word=True)
        if action == 'deploy-test' and layer == 'project':
            cleaners['target'] = board_target
        current = data.get('actions', {}).get(action, {})
        if values := board_section_edits(current, wanted, cleaners, action):
            edits[('actions', action)] = values
    if 'advisor' in changes:
        if layer != 'global':
            raise Refused('參謀範圍只能在全域設定修改')
        cleaners = {key: lambda value: board_list(value, '參謀範圍') for key in ADVISOR_LISTS}
        if values := board_section_edits(data.get('advisor', {}), changes['advisor'], cleaners,
                                         'advisor'):
            edits[('advisor',)] = values
    return edits


def board_write(layer, workspace, expected_sha256, changes):
    """Write one layer for the board, as one JSON-ready result. `status` is ok, conflict (the file
    is not the one read), invalid (refused; nothing changed), log_failed (no record could be
    written, so the file was restored) or restore_failed (nor could it be restored)."""
    if layer == 'global':
        target = global_path()
    else:
        top = git(workspace, 'rev-parse', '--show-toplevel') if workspace else None
        if not top:
            return dict(status='invalid', reason=f'{workspace} 不在 Git 專案裡', problems=[])
        target = shared_lat_dir(Path(top)) / 'preauth.toml'
    try:
        with locked(target.with_name(f'.{target.name}.lock')):
            result = board_write_locked(layer, target, expected_sha256, changes)
    except LayerInvalid as error:
        return dict(status='invalid', reason='設定檔有錯，沒有寫入，修好檔案後重新載入',
                    problems=error.problems)
    except Conflict:
        return dict(status='conflict', reason='設定檔已被改過，沒有寫入，請重新載入', problems=[])
    except Refused as error:
        return dict(status='invalid', reason=f'沒有寫入：{error}', problems=[])
    return dict(result, settings=board_settings(workspace)) if result['status'] == 'ok' else result


def board_write_locked(layer, target, expected_sha256, changes):
    loaded, problems = file_layer(layer, target)
    if problems:
        raise LayerInvalid(problems)
    if loaded.sha256 != expected_sha256:
        raise Conflict(f'{target} changed after it was read')
    edits = board_edits(layer, loaded.data, changes)
    listed = [dict(section='.'.join(table), key=key, value=value)
              for table, values in edits.items() for key, value in values.items()]
    if not edits:
        return dict(status='ok', changes=[])
    stamp = f'board:{datetime.now().astimezone().isoformat(timespec="seconds")}'
    stamped = {table: dict(values, source=stamp) for table, values in edits.items()}
    before, written = write_file_layer(target, stamped, expected_sha256=expected_sha256)
    try:
        append_board_write(dict(layer=layer, file=str(target), changes=listed, source=stamp))
    except (OSError, ValueError) as error:
        # A write the report cannot list must not stay in effect.
        try:
            restore(target, before, written)
        except (OSError, ValueError) as undo:
            try:
                current = target.read_text(encoding='utf-8')
            except (OSError, UnicodeDecodeError) as unread:
                current = f'（讀不到：{unread}）'
            return dict(status='restore_failed', current=current,
                        to_undo=undo_lines(loaded.data, stamped),
                        reason=f'紀錄寫不進去（{error}），也無法還原（{undo}），請手動改回 {target}')
        return dict(status='log_failed', reason=f'紀錄寫不進去（{error}），設定已還原')
    return dict(status='ok', changes=listed)


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
    sub = commands.add_parser('notice', parents=[common],
                              help='send a before/after notice and print its HCOM event ID (none-<n> '
                                   'when no other controller is live)')
    sub.add_argument('--text', required=True, help='notice text')
    sub.add_argument('--to', nargs='+', metavar='NAME',
                     help='recipients; default the other active controllers of this session')
    commands.add_parser('show', parents=[common],
                        help='effective settings and where each value came from')
    sub = commands.add_parser('grant', parents=[common],
                              help='write one rule a human-answered decision record names')
    sub.add_argument('--layer', required=True, choices=('global', 'project'))
    sub.add_argument('--action', required=True, help=', '.join(ACTIONS))
    sub.add_argument('--allow', choices=('true', 'false'))
    sub.add_argument('--branches', nargs='+', help='branch names')
    sub.add_argument('--source', required=True, help='decision record ID with the answer')
    sub = commands.add_parser('record', parents=[common],
                              help='log one thing done under pre-authorization')
    sub.add_argument('--kind', choices=('auto', 'bug-intake'), default='auto',
                     help='auto: an action done under pre-authorization (default); bug-intake: a '
                          'short-flow bug ticket started without confirmation')
    sub.add_argument('--action', help='auto: ' + ', '.join(ACTIONS))
    sub.add_argument('--branch', help='auto: target branch')
    sub.add_argument('--commit', help='auto: commit the action used')
    sub.add_argument('--basis', help='auto: the check line')
    sub.add_argument('--result', choices=RESULTS, help='auto: how the action ended')
    sub.add_argument('--started', help='auto deploy/install: ISO time the action started')
    sub.add_argument('--notice-before', type=notice_id, help='auto deploy/install: HCOM event ID '
                                                             'of the notice sent before '
                                                             'starting, or the none-<n> id of '
                                                             'a no-one-to-notify result')
    sub.add_argument('--notice-after', type=notice_id, help='auto deploy/install: HCOM event ID '
                                                            'of the notice sent after '
                                                            'finishing, or a none-<n> id')
    sub.add_argument('--source', help="bug-intake: where the user's own message is")
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
    commands = {'check': cmd_check, 'show': cmd_show, 'grant': cmd_grant, 'notice': cmd_notice,
                'record': cmd_record, 'report': cmd_report}
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

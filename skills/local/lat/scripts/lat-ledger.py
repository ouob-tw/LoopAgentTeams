#!/usr/bin/env python3
"""Work ledger for one LAT orchestrator round (stdlib only).

Only this program writes the ledger. Each write replaces the JSON file atomically under a
lock, rewrites the seal (SHA-256 of the file) and appends the new snapshot to the journal
beside it. A read refuses a ledger whose seal does not match (a hand edit, even a well-formed
one) or whose content is malformed; `repair` recovers either case with a stated reason.
Closing an item needs evidence the program can find: a commit reachable from a branch, a
suite-gate record fingerprint, or a non-empty file. The program only checks that evidence
exists; whether the work passed acceptance stays the orchestrator's call.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lat_common import full_hcom_name, read_hcom_list, run_cli, same_controller, write_text_atomic

LAT_DIR = Path(__file__).resolve().parents[1]
# Overrides for tests: a fixed clock, another suite-gate script and a file for `hcom list --json`.
NOW_ENV = 'LAT_LEDGER_NOW'
GATE_ENV = 'LAT_LEDGER_SUITE_GATE'
HCOM_LIST_ENV = 'LAT_LEDGER_HCOM_LIST'
READ_ONLY = ('next', 'check', 'show')
VERSION = 1
STAGES = {'impl': '實作', 'review': '審查', 'qa-draft': 'QA 草稿', 'qa': '驗收',
          'merge': '整合', 'spec-review': 'Spec 審查', 'research': '研究', 'advisor': '參謀',
          'other': '其他'}
STATUSES = {'unassigned': '未派', 'assigned': '已派', 'in_progress': '進行中',
            'blocked': '受阻', 'done': '已結案', 'cancelled': '已取消'}
KINDS = ('commit', 'gate', 'file')
OPEN = ('assigned', 'in_progress', 'blocked')
DEP_CANCELLED = '依賴已取消'
CARD_FIELD = re.compile(r'-\s+([^：:\n]+)[：:]\s*(.*)')
CARD_CLOSED = ('committed', 'merged', 'completed')
RELATIVE = re.compile(r'\+(\d+)([mhd])')


class Failure(Exception):
    """The request cannot be served; the message goes to stderr."""


def now():
    fixed = os.environ.get(NOW_ENV)
    return parse_time(fixed, base=None) if fixed else datetime.now(timezone.utc)


def parse_time(text, base):
    """ISO 8601 (naive means local time) or +N[m|h|d] from base; returns aware UTC."""
    match = RELATIVE.fullmatch(text.strip())
    if match and base is not None:
        unit = {'m': 'minutes', 'h': 'hours', 'd': 'days'}[match.group(2)]
        return base + timedelta(**{unit: int(match.group(1))})
    try:
        value = datetime.fromisoformat(text.strip().replace('Z', '+00:00'))
    except ValueError as error:
        raise Failure(f'invalid time {text!r}: use ISO 8601 or +N[m|h|d]') from error
    if value.tzinfo is None:
        value = value.astimezone()
    return value.astimezone(timezone.utc)


def stamp(value):
    return value.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def loads_time(text):
    return datetime.fromisoformat(text.replace('Z', '+00:00'))


def actor(args):
    return args.by


def resolve_names(args):
    """Turn --by (default $HCOM_INSTANCE_NAME), --orchestrator and --agent into HCOM full names
    before anything is written; without any HCOM name the OS user acts. An unreadable HCOM
    list refuses the command rather than writing a name it could not check."""
    by = args.by or os.environ.get('HCOM_INSTANCE_NAME')
    # (attribute, flag, name): init takes --orchestrator, assign/reassign --agent.
    names = [('by', '--by', by),
             ('orchestrator', '--orchestrator', getattr(args, 'orchestrator', None))]
    if not getattr(args, 'native', False):
        names.append(('agent', '--agent', getattr(args, 'agent', None)))
    names = [entry for entry in names if entry[2]]
    if names:
        agents = {item['name'] for item in read_hcom_list(HCOM_LIST_ENV)
                  if isinstance(item.get('name'), str)}
        for attribute, flag, name in names:
            setattr(args, attribute, full_hcom_name(agents, name, flag))
    if not by:
        args.by = getpass.getuser()


def item_ids(text):
    try:
        return sorted({int(part) for part in text.split(',') if part.strip()})
    except ValueError as error:
        raise Failure(f'invalid item list {text!r}: use comma-separated numbers') from error


def kinds_of(values):
    kinds = []
    for value in values:
        for part in value.split(','):
            part = part.strip()
            if part not in KINDS:
                raise Failure(f'unknown evidence kind {part!r}; use {", ".join(KINDS)}')
            if part not in kinds:
                kinds.append(part)
    return kinds


# ---- storage --------------------------------------------------------------------------

class Store:
    def __init__(self, path):
        path = Path(path)
        if not path.is_absolute():
            raise Failure(f'--ledger must be an absolute path: {path}')
        self.path = path
        self.seal = path.with_name(path.name + '.seal')
        self.journal = path.with_name(path.name + '.journal.jsonl')
        self.lock = path.with_name(path.name + '.lock')


def serialize(doc):
    return json.dumps(doc, indent=2, ensure_ascii=False) + '\n'


def digest(data):
    return hashlib.sha256(data).hexdigest()


@contextmanager
def locked(store, exclusive):
    store.path.parent.mkdir(parents=True, exist_ok=True)
    with open(store.lock, 'a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield


def validate(doc):
    """Raise ValueError naming the first structural problem."""
    if not isinstance(doc, dict) or doc.get('version') != VERSION:
        raise ValueError(f'expected an object with version {VERSION}')
    for key in ('workspace', 'created_at'):
        if not isinstance(doc.get(key), str):
            raise ValueError(f'{key} must be a string')
    if not isinstance(doc.get('history'), list) or not isinstance(doc.get('next_id'), int):
        raise ValueError('history must be a list and next_id a number')
    items = doc.get('items')
    if not isinstance(items, list):
        raise ValueError('items must be a list')
    seen = set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get('id'), int):
            raise ValueError('every item needs a numeric id')
        if item['id'] in seen or item['id'] >= doc['next_id']:
            raise ValueError(f'item {item["id"]}: duplicate or out-of-range id')
        seen.add(item['id'])
        if item.get('status') not in STATUSES or item.get('stage') not in STAGES:
            raise ValueError(f'item {item["id"]}: unknown status or stage')
        kinds = item.get('evidence_kinds')
        if not isinstance(kinds, list) or not kinds or any(k not in KINDS for k in kinds):
            raise ValueError(f'item {item["id"]}: invalid evidence kinds')
        if not isinstance(item.get('depends_on'), list) or not isinstance(item.get('history'), list):
            raise ValueError(f'item {item["id"]}: depends_on and history must be lists')
        if not isinstance(item.get('evidence'), dict):
            raise ValueError(f'item {item["id"]}: evidence must be an object')
    for item in items:
        if any(dep not in seen for dep in item['depends_on']):
            raise ValueError(f'item {item["id"]}: depends on a missing item')


def parse_ledger(data):
    doc = json.loads(data.decode('utf-8'))
    validate(doc)
    return doc


def load(store):
    """Return (doc, raw bytes); refuse a missing, malformed or unsealed ledger."""
    try:
        data = store.path.read_bytes()
    except FileNotFoundError:
        if store.journal.exists():
            raise Failure(f'ledger missing: {store.path}; rebuild it with '
                          'repair --from-journal --reason "<why>"') from None
        raise Failure(f'no ledger at {store.path}; create it with init') from None
    try:
        doc = parse_ledger(data)
    except (ValueError, UnicodeError) as error:
        raise Failure(f'ledger is malformed ({error}): {store.path}; rebuild it with '
                      'repair --from-journal --reason "<why>"') from error
    try:
        sealed = store.seal.read_text().strip()
    except FileNotFoundError:
        sealed = None
    if sealed != digest(data):
        raise Failure(f'ledger was modified outside lat-ledger (seal mismatch): {store.path}; '
                      'inspect the change, then accept it with repair --reason "<why>"')
    if journal_tail_seal(store) != sealed:
        raise Failure(f'journal does not end with this ledger state (a write did not finish): '
                      f'{store.journal}; inspect the ledger, then accept it with '
                      'repair --reason "<why>"')
    return doc, data


def journal_tail_seal(store):
    """Seal of the last journal line, or None when it cannot be read."""
    try:
        with open(store.journal, 'rb') as stream:
            stream.seek(0, os.SEEK_END)
            end = position = stream.tell()
            tail = b''
            while position and tail.count(b'\n') < 2:
                position = max(0, position - 65536)
                stream.seek(position)
                tail = stream.read(end - position)
        return json.loads(tail.rstrip(b'\n').rpartition(b'\n')[2])['seal']
    except (OSError, ValueError, KeyError, TypeError):
        return None


def save(store, doc, expected, entry):
    """Atomic replace, seal, then journal; `entry` describes the change for the journal."""
    text = serialize(doc)
    data = write_text_atomic(store.path, text, expected=expected, mode=0o644)
    sealed = digest(data)
    write_text_atomic(store.seal, sealed + '\n', mode=0o644)
    line = json.dumps(dict(entry, seal=sealed, snapshot=doc), ensure_ascii=False) + '\n'
    with open(store.journal, 'a+b') as stream:
        if stream.tell():
            stream.seek(-1, os.SEEK_END)
            if stream.read(1) != b'\n':
                line = '\n' + line  # an interrupted append left a partial line; end it
        stream.write(line.encode('utf-8'))
        stream.flush()
        os.fsync(stream.fileno())


def read_journal(store):
    """The last journal snapshot, checked against its seal; Failure when unusable.

    Earlier unreadable lines (a partial append that a later write ended) are skipped with a
    warning, since every line holds a full snapshot; the last line must be valid.
    """
    try:
        lines = store.journal.read_bytes().splitlines()  # decode per line: a cut-off
        # append may end inside a multibyte character
    except FileNotFoundError:
        raise Failure(f'journal missing: {store.journal}; the ledger cannot be rebuilt and '
                      'no empty ledger is created') from None
    except OSError as error:
        raise Failure(f'journal unreadable: {error}') from error
    if not lines:
        raise Failure(f'journal is empty: {store.journal}; the ledger cannot be rebuilt')
    try:
        entry = json.loads(lines[-1])
        snapshot = entry['snapshot']
        validate(snapshot)
        if digest(serialize(snapshot).encode('utf-8')) != entry['seal']:
            raise ValueError('snapshot does not match its seal')
    except (ValueError, KeyError, TypeError) as error:
        raise Failure(f'journal line {len(lines)} is corrupt ({error}): {store.journal}; '
                      'the ledger cannot be rebuilt and no empty ledger is created') from error
    for number, line in enumerate(lines[:-1], 1):
        try:
            json.loads(line)['seal']
        except (ValueError, KeyError, TypeError):
            print(f'lat-ledger: warning: skipped unreadable journal line {number}',
                  file=sys.stderr)
    return snapshot


@contextmanager
def transaction(args, action, item_id=None, reason=None):
    """Load under an exclusive lock, yield the document, save when the body succeeds."""
    store = Store(args.ledger)
    with locked(store, exclusive=True):
        doc, data = load(store)
        yield doc
        doc['updated_at'] = stamp(now())
        save(store, doc, data, {'at': doc['updated_at'], 'by': actor(args), 'action': action,
                                'item': item_id, 'reason': reason})


def read_only(args):
    store = Store(args.ledger)
    with locked(store, exclusive=False):
        return load(store)[0]


def find(doc, item_id):
    for item in doc['items']:
        if item['id'] == item_id:
            return item
    raise Failure(f'no item {item_id} in the ledger')


def record(args, item, action, changes, reason=None):
    """Apply {field: new} to the item and add one history entry with old -> new."""
    diff = {}
    for field, value in changes.items():
        if item.get(field) != value:
            diff[field] = [item.get(field), value]
            item[field] = value
    item['history'].append({'at': stamp(now()), 'by': actor(args), 'action': action,
                            'changes': diff, 'reason': reason})


def block_for_cancelled_dependency(args, item, why):
    """Block an open item; an item already blocked keeps its own reason after the prefix."""
    if item['status'] == 'blocked':
        if item['blocked_reason'].startswith(DEP_CANCELLED):
            return
        changes = {'blocked_reason': f'{DEP_CANCELLED}；{item["blocked_reason"]}'}
    elif item['status'] in ('unassigned', 'assigned', 'in_progress'):
        changes = {'status': 'blocked', 'blocked_from': item['status'],
                   'blocked_reason': DEP_CANCELLED}
    else:
        return
    record(args, item, 'block', changes, why)


def sync_cancelled_dependencies(args, doc, item, why):
    """Block while any dependency is cancelled; release that block once none is."""
    if any(find(doc, dep)['status'] == 'cancelled' for dep in item['depends_on']):
        block_for_cancelled_dependency(args, item, why)
    elif item['status'] == 'blocked' and item['blocked_reason'].startswith(DEP_CANCELLED):
        rest = item['blocked_reason'][len(DEP_CANCELLED) + 1:]
        if rest:
            record(args, item, 'block', {'blocked_reason': rest}, why)
        else:
            record(args, item, 'unblock', {'status': item['blocked_from'], 'blocked_from': None,
                                           'blocked_reason': None}, why)


def require_status(item, allowed, action):
    if item['status'] not in allowed:
        raise Failure(f'item {item["id"]} is {item["status"]}; {action} needs '
                      + ' or '.join(allowed))


def required_text(label, value):
    if value is None or not value.strip():
        raise Failure(f'{label} is required and must not be empty')
    return value.strip()


# ---- evidence -------------------------------------------------------------------------

def gate_script():
    return Path(os.environ.get(GATE_ENV) or
                LAT_DIR.parent / 'three-tier-testing' / 'scripts' / 'suite-gate.py')


def check_repo(path):
    """Return (absolute repo path, problem); the path must be inside a git repository."""
    if not Path(path).is_absolute():
        return None, f'--repo {path}: must be an absolute path'
    try:
        run_cli(['git', '-C', path, 'rev-parse', '--git-dir'], timeout=30)
    except ValueError:
        return None, f'--repo {path}: not a git repository'
    return str(Path(path)), None


def branch_exists(repo, branch):
    try:
        run_cli(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', f'{branch}^{{commit}}'],
                timeout=30)
        return True
    except ValueError:
        return False


def verify_commit(doc, item, value):
    """Return (full sha, problem); the commit must reach the item or integration branch.

    A row with its own repo is checked there. The branches are only enforced where they exist
    in that repo, since the integration branch name belongs to the workspace."""
    workspace = item.get('repo') or doc['workspace']
    if item.get('repo'):
        _, problem = check_repo(workspace)
        if problem:
            return None, f'commit {value}: {problem}'
    try:
        sha = run_cli(['git', '-C', workspace, 'rev-parse', '--verify', '--quiet',
                       f'{value}^{{commit}}'], timeout=30).strip()
    except ValueError:
        return None, f'commit {value}: not found in {workspace}'
    branches = [b for b in (item.get('branch'), doc.get('integration_branch')) if b]
    if item.get('repo'):
        branches = [b for b in branches if branch_exists(workspace, b)]
        if not branches:
            return sha, None
    if not branches:
        return sha, f'commit {value}: no branch to check reachability (set --branch on the item)'
    for branch in branches:
        try:
            run_cli(['git', '-C', workspace, 'merge-base', '--is-ancestor', sha, branch],
                    timeout=30)
            return sha, None
        except ValueError:
            continue
    return sha, f'commit {value} is not reachable from {" or ".join(branches)} in {workspace}'


def verify_gate(doc, value):
    script = gate_script()
    try:
        output = run_cli([sys.executable, str(script), 'status', '--json', '--fingerprint',
                          value, '--limit', '100000'], timeout=60,
                         failure='suite-gate status failed')
        records = json.loads(output)['records']
    except (ValueError, KeyError, TypeError) as error:
        return None, f'gate record {value}: lookup failed ({error})'
    found = {r.get('fingerprint') or r.get('reused_fingerprint') for r in records
             if isinstance(r, dict)} - {None}
    if value in found:
        return value, None
    if len(found) == 1:
        return found.pop(), None
    if found:
        return None, f'gate record {value}: prefix matches several fingerprints; give it in full'
    return None, f'gate record {value}: no suite-gate record with this fingerprint'


def verify_file(value):
    path = Path(value)
    if not path.is_absolute():
        return None, f'file {value}: must be an absolute path'
    try:
        if not path.is_file():
            return None, f'file {value}: does not exist or is not a file'
        if path.stat().st_size == 0:
            return None, f'file {value}: is empty'
    except OSError as error:
        return None, f'file {value}: {error}'
    return str(path), None


def verify(doc, item, evidence):
    """Check every value; return (resolved evidence, problems)."""
    resolved, problems = {}, []
    for kind in KINDS:
        for value in evidence.get(kind, []):
            if kind == 'commit':
                full, problem = verify_commit(doc, item, value)
            elif kind == 'gate':
                full, problem = verify_gate(doc, value)
            else:
                full, problem = verify_file(value)
            if problem:
                problems.append(problem)
            else:
                resolved.setdefault(kind, []).append(full)
    return resolved, problems


# ---- task card ------------------------------------------------------------------------

def card_status(path):
    if not path:
        return None, 'no task card'
    try:
        text = Path(path).read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        return None, f'task card unreadable: {path}'
    for line in text.splitlines():
        match = CARD_FIELD.fullmatch(line.strip())
        if match and match.group(1).strip().lower() == 'status':
            return match.group(2).strip(), None
    return None, f'task card has no status: {path}'


def card_mismatch(item):
    if item['status'] in ('unassigned', 'cancelled'):
        return None
    status, problem = card_status(item.get('card'))
    if problem:
        return problem
    closed = status in CARD_CLOSED
    if item['status'] == 'done' and not closed:
        return f'card says {status}, ledger says done'
    if item['status'] != 'done' and closed:
        return f'card says {status}, ledger says {item["status"]}'
    return None


def update_card(item, resolved):
    """Mirror a close into the task card; a failure only warns (the ledger is authoritative)."""
    path = item.get('card')
    if not path:
        return
    commits = resolved.get('commit')
    values = {'status': 'committed' if commits else 'completed'}
    if commits:
        values['deliverable commit'] = ', '.join(commits)
    try:
        text = Path(path).read_text(encoding='utf-8')
        lines = text.splitlines(keepends=True)
        for index, line in enumerate(lines):
            match = CARD_FIELD.fullmatch(line.strip())
            if match and match.group(1).strip().lower() in values:
                key = match.group(1).strip()
                ending = '\n' if line.endswith('\n') else ''
                lines[index] = f'- {key}：{values.pop(key.lower())}{ending}'
        write_text_atomic(path, ''.join(lines), expected=text.encode('utf-8'))
    except (OSError, UnicodeError, ValueError) as error:
        print(f'lat-ledger: warning: task card not updated: {error}', file=sys.stderr)


# ---- commands -------------------------------------------------------------------------

def cmd_init(args):
    store = Store(args.ledger)
    workspace = Path(args.workspace)
    if not workspace.is_absolute() or not workspace.is_dir():
        raise Failure(f'--workspace must be an existing absolute directory: {workspace}')
    with locked(store, exclusive=True):
        existing = [p for p in (store.path, store.seal, store.journal) if p.exists()]
        if existing:
            raise Failure(f'ledger already exists ({existing[0]}); init never overwrites it')
        at = stamp(now())
        doc = {'version': VERSION, 'workspace': str(workspace),
               'integration_branch': args.integration_branch, 'orchestrator': args.orchestrator,
               'created_at': at, 'updated_at': at, 'next_id': 1, 'items': [],
               'history': [{'at': at, 'by': actor(args), 'action': 'init', 'reason': None}]}
        save(store, doc, None, {'at': at, 'by': actor(args), 'action': 'init', 'item': None,
                                'reason': None})
    print(store.path)


def cmd_add(args):
    kinds = kinds_of(args.evidence)
    ticket = required_text('--ticket', args.ticket)
    repo = None
    if args.repo:
        repo, problem = check_repo(args.repo)
        if problem:
            raise Failure(problem)
    with transaction(args, 'add') as doc:
        known = {item['id'] for item in doc['items']}
        deps = item_ids(args.depends) if args.depends else []
        missing = [d for d in deps + ([args.follows] if args.follows else []) if d not in known]
        if missing:
            raise Failure(f'unknown item(s): {", ".join(map(str, missing))}')
        at = now()
        item = {'id': doc['next_id'], 'ticket': ticket, 'stage': args.stage, 'agent': None,
                'card': None, 'branch': args.branch, 'repo': repo, 'status': 'unassigned',
                'depends_on': deps, 'follows': args.follows, 'assigned_at': None,
                'started_at': None, 'estimate': None,
                'deadline': stamp(parse_time(args.deadline, at)) if args.deadline else None,
                'evidence_kinds': kinds, 'evidence': {}, 'progress': None,
                'blocked_reason': None, 'blocked_from': None, 'cancel_reason': None,
                'history': []}
        doc['next_id'] += 1
        doc['items'].append(item)
        item['history'].append({'at': stamp(at), 'by': actor(args), 'action': 'add',
                                'changes': {'status': [None, 'unassigned']}, 'reason': None})
        sync_cancelled_dependencies(args, doc, item, 'depends on a cancelled item')
    print(item['id'])


def cmd_assign(args):
    agent = required_text('--agent', args.agent)
    card = required_text('--card', args.card)
    with transaction(args, 'assign', args.id) as doc:
        item = find(doc, args.id)
        require_status(item, ('unassigned',), 'assign')
        at = now()
        deadline = stamp(parse_time(args.deadline, at)) if args.deadline else item['deadline']
        if not deadline:
            raise Failure('--deadline is required (the item has no deadline yet)')
        record(args, item, 'assign', {'status': 'assigned', 'agent': agent, 'card': card,
                                      'deadline': deadline, 'assigned_at': stamp(at)})


def cmd_start(args):
    with transaction(args, 'start', args.id) as doc:
        item = find(doc, args.id)
        require_status(item, ('assigned',), 'start')
        at = now()
        record(args, item, 'start', {'status': 'in_progress', 'started_at': stamp(at),
                                     'estimate': stamp(parse_time(args.eta, at))})


def cmd_update(args):
    reason = args.reason.strip() if args.reason else None
    if (args.eta or args.deadline or args.depends is not None) and not reason:
        raise Failure('--reason is required when changing --eta, --deadline or --depends')
    if not any((args.eta, args.deadline, args.progress, args.card, args.branch,
                args.depends is not None)):
        raise Failure('nothing to update; give --eta, --deadline, --progress, --card, --branch '
                      'or --depends')
    with transaction(args, 'update', args.id, reason) as doc:
        item = find(doc, args.id)
        if args.eta or args.deadline or args.progress:
            require_status(item, OPEN, 'update')
        elif args.depends is not None:
            require_status(item, ('unassigned',) + OPEN, 'update --depends')
        at = now()
        changes = {}
        if args.eta:
            if item['status'] != 'in_progress':
                raise Failure(f'item {item["id"]} is {item["status"]}; --eta needs in_progress')
            changes['estimate'] = stamp(parse_time(args.eta, at))
        if args.deadline:
            changes['deadline'] = stamp(parse_time(args.deadline, at))
        if args.progress:
            changes['progress'] = args.progress.strip()
        if args.card:
            changes['card'] = args.card
        if args.branch:
            changes['branch'] = args.branch
        if args.depends is not None:
            deps = item_ids(args.depends)
            known = {other['id'] for other in doc['items']}
            if any(d not in known or d == item['id'] for d in deps):
                raise Failure(f'--depends names an unknown item or the item itself: {args.depends}')
            changes['depends_on'] = deps
        record(args, item, 'update', changes, reason)
        if args.depends is not None:
            sync_cancelled_dependencies(args, doc, item, 'dependencies changed')


def cmd_block(args):
    reason = required_text('--reason', args.reason)
    with transaction(args, 'block', args.id, reason) as doc:
        item = find(doc, args.id)
        require_status(item, ('unassigned', 'assigned', 'in_progress'), 'block')
        record(args, item, 'block', {'status': 'blocked', 'blocked_from': item['status'],
                                     'blocked_reason': reason}, reason)


def cmd_unblock(args):
    with transaction(args, 'unblock', args.id, args.reason) as doc:
        item = find(doc, args.id)
        require_status(item, ('blocked',), 'unblock')
        cancelled = [d for d in item['depends_on'] if find(doc, d)['status'] == 'cancelled']
        if cancelled:
            raise Failure(f'item {item["id"]} still depends on cancelled item(s) '
                          f'{", ".join(map(str, cancelled))}; change them with update --depends')
        record(args, item, 'unblock', {'status': item['blocked_from'], 'blocked_from': None,
                                       'blocked_reason': None}, args.reason)


def cmd_done(args):
    given = {'commit': args.commit or [], 'gate': args.gate or [], 'file': args.file or []}
    with transaction(args, 'done', args.id) as doc:
        item = find(doc, args.id)
        require_status(item, ('assigned', 'in_progress'), 'done')
        changes = {'status': 'done'}
        if args.repo:
            repo, problem = check_repo(args.repo)
            if problem:
                raise Failure(f'item {item["id"]} not closed:\n  - {problem}')
            changes['repo'] = repo
        problems = [f'{kind} evidence is required for this item' for kind in
                    item['evidence_kinds'] if not given[kind]]
        problems += [f'{kind} evidence was not declared for this item' for kind in KINDS
                     if given[kind] and kind not in item['evidence_kinds']]
        resolved, failed = verify(doc, {**item, **changes}, {kind: given[kind]
                                                              for kind in item['evidence_kinds']})
        problems += failed
        if problems:
            raise Failure(f'item {item["id"]} not closed:\n' +
                          '\n'.join(f'  - {problem}' for problem in problems))
        changes['evidence'] = resolved
        record(args, item, 'done', changes)
    update_card(item, resolved)
    print(f'item {item["id"]} closed')


def cmd_cancel(args):
    reason = required_text('--reason', args.reason)
    with transaction(args, 'cancel', args.id, reason) as doc:
        if doc.get('orchestrator') and not same_controller(doc['orchestrator'], actor(args)):
            raise Failure(f'only the orchestrator {doc["orchestrator"]} may cancel items')
        item = find(doc, args.id)
        require_status(item, ('unassigned',) + OPEN, 'cancel')
        record(args, item, 'cancel', {'status': 'cancelled', 'cancel_reason': reason}, reason)
        for other in doc['items']:
            if item['id'] in other['depends_on']:
                block_for_cancelled_dependency(args, other, f'item {item["id"]} was cancelled')


def cmd_reassign(args):
    agent = required_text('--agent', args.agent)
    reason = required_text('--reason', args.reason)
    with transaction(args, 'reassign', args.id, reason) as doc:
        item = find(doc, args.id)
        require_status(item, OPEN, 'reassign')
        if not item['agent']:
            raise Failure(f'item {item["id"]} was never assigned; use assign')
        changes = {'agent': agent, 'assigned_at': stamp(now()), 'started_at': None,
                   'estimate': None}
        if args.card:
            changes['card'] = args.card
        if item['status'] == 'blocked':
            changes['blocked_from'] = 'assigned'
        else:
            changes['status'] = 'assigned'
        record(args, item, 'reassign', changes, reason)


def ready(doc):
    done = {item['id'] for item in doc['items'] if item['status'] == 'done'}
    return [item for item in doc['items'] if item['status'] == 'unassigned'
            and all(dep in done for dep in item['depends_on'])]


def cmd_next(args):
    items = ready(read_only(args))
    if args.json:
        print(json.dumps([{'id': i['id'], 'ticket': i['ticket'], 'stage': i['stage']}
                          for i in items], ensure_ascii=False, indent=1))
    elif not items:
        print('nothing ready to dispatch')
    else:
        for item in items:
            print(f'{item["id"]}\t{item["ticket"]}\t{item["stage"]}')
    return 0


def cmd_check(args):
    doc = read_only(args)
    failures, cancelled = [], []
    repos = [{'id': item['id'], 'repo': item['repo']} for item in doc['items']
             if item.get('repo') and item['status'] != 'cancelled']
    for item in doc['items']:
        repo = f', repo {item["repo"]}' if item.get('repo') else ''
        label = f'item {item["id"]} ({item["ticket"]} {item["stage"]}{repo})'
        if item['status'] == 'cancelled':
            cancelled.append({'id': item['id'], 'label': label, 'reason': item['cancel_reason']})
            continue
        if item['status'] != 'done':
            failures.append({'id': item['id'], 'label': label,
                             'problems': [f'not closed: {item["status"]}']})
            continue
        try:
            _, problems = verify(doc, item, item['evidence'])
        except Exception as error:  # A crash in a lookup must never read as a pass.
            problems = [f'evidence check failed: {error}']
        missing = [k for k in item['evidence_kinds'] if not item['evidence'].get(k)]
        problems += [f'{kind} evidence missing from the record' for kind in missing]
        if problems:
            failures.append({'id': item['id'], 'label': label, 'problems': problems})
    if args.json:
        print(json.dumps({'ok': not failures, 'failures': failures, 'cancelled': cancelled,
                          'repos': repos},
                         ensure_ascii=False, indent=1))
    else:
        print('ledger check: ' + ('FAIL' if failures else 'OK') +
              f' ({len(doc["items"])} items)')
        for entry in repos:
            print(f'- item {entry["id"]} repo: {entry["repo"]}')
        for failure in failures:
            print(f'- {failure["label"]}: ' + '; '.join(failure['problems']))
        for entry in cancelled:
            print(f'- cancelled {entry["label"]}: {entry["reason"]}')
    return 1 if failures else 0


def lateness(item, at):
    """Minutes past the estimate and the deadline, counted only while they still apply."""
    late = {}
    if item['status'] == 'in_progress' and item['estimate']:
        late['estimate'] = (at - loads_time(item['estimate'])).total_seconds() // 60
    if item['status'] in OPEN and item['deadline']:
        late['deadline'] = (at - loads_time(item['deadline'])).total_seconds() // 60
    return {key: int(value) for key, value in late.items() if value > 0}


def duration(minutes):
    hours, minutes = divmod(minutes, 60)
    return f'{hours}h{minutes:02d}m' if hours else f'{minutes}m'


def cell(value):
    return '' if value is None else str(value).replace('|', '\\|').replace('\n', ' ')


def cmd_show(args):
    doc = read_only(args)
    at = now()
    rows = []
    for item in doc['items']:
        view = dict(item)
        view['late_minutes'] = lateness(item, at)
        view['card_mismatch'] = card_mismatch(item)
        view['stage_label'] = STAGES[item['stage']]
        view['status_label'] = STATUSES[item['status']]
        rows.append(view)
    if args.json:
        print(json.dumps({'ledger': str(Path(args.ledger)), 'now': stamp(at),
                          'workspace': doc['workspace'], 'created_at': doc['created_at'],
                          'updated_at': doc['updated_at'], 'items': rows},
                         ensure_ascii=False, indent=1))
        return 0
    print(f'工作總表 {args.ledger}（更新於 {doc["updated_at"]}）\n')
    print('| # | 票號 | 階段 | 負責 | 狀態 | 依賴 | 預計完成 | 最晚期限 | 遲到 | 備註 |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    for row in rows:
        late = '；'.join(f'{"超過預計" if key == "estimate" else "超過期限"} {duration(value)}'
                        for key, value in row['late_minutes'].items())
        notes = [text for text in (
            row['blocked_reason'] and f'受阻：{row["blocked_reason"]}',
            row['cancel_reason'] and f'取消：{row["cancel_reason"]}',
            row['follows'] and f'接續自 {row["follows"]}',
            row.get('repo') and f'repo：{row["repo"]}',
            row['card_mismatch'] and f'任務卡不一致：{row["card_mismatch"]}',
            row['progress'] and f'進度：{row["progress"]}') if text]
        print('| ' + ' | '.join(cell(value) for value in (
            row['id'], row['ticket'], row['stage_label'], row['agent'], row['status_label'],
            ','.join(map(str, row['depends_on'])), row['estimate'], row['deadline'], late,
            '；'.join(notes))) + ' |')
    return 0


def cmd_repair(args):
    reason = required_text('--reason', args.reason)
    store = Store(args.ledger)
    with locked(store, exclusive=True):
        at = stamp(now())
        entry = {'at': at, 'by': actor(args), 'reason': reason, 'item': None}
        if args.from_journal:
            doc = read_journal(store)
            entry['action'] = 'repair-from-journal'
        else:
            try:
                data = store.path.read_bytes()
                doc = parse_ledger(data)
            except FileNotFoundError:
                raise Failure(f'ledger missing: {store.path}; use repair --from-journal') from None
            except (ValueError, UnicodeError) as error:
                raise Failure(f'ledger is malformed ({error}); use repair --from-journal, '
                              'which rebuilds it from the journal') from error
            sealed = store.seal.read_text().strip() if store.seal.exists() else None
            if sealed == digest(data) and journal_tail_seal(store) == sealed:
                raise Failure('ledger seal and journal match; nothing to repair')
            entry['action'] = 'repair-seal'
        doc['history'].append({key: entry[key] for key in ('at', 'by', 'action', 'reason')})
        doc['updated_at'] = at
        current = store.path.read_bytes() if store.path.exists() else None
        save(store, doc, current, entry)
        load(store)  # report failure rather than success when the repair did not take
    print(f'ledger repaired ({entry["action"]}): {store.path}')
    if args.from_journal:
        cmd_show(argparse.Namespace(ledger=args.ledger, json=False))


# ---- CLI ------------------------------------------------------------------------------

def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--ledger', required=True, help='absolute path of the ledger JSON')
    common.add_argument('--by', help='who acts; default $HCOM_INSTANCE_NAME, then the OS user. '
                        'HCOM names are stored as full names')
    parser = argparse.ArgumentParser(description='LAT work ledger')
    commands = parser.add_subparsers(dest='command', required=True)

    def command(name, text, item=True):
        sub = commands.add_parser(name, parents=[common], help=text)
        if item:
            sub.add_argument('id', type=int, help='item number')
        return sub

    sub = command('init', 'Create a new ledger', item=False)
    sub.add_argument('--workspace', required=True, help='main workspace (absolute)')
    sub.add_argument('--integration-branch', help='branch every commit may reach, e.g. dev')
    sub.add_argument('--orchestrator', help='HCOM name allowed to cancel items, stored as the '
                     'full name')
    sub = command('add', 'Add an item', item=False)
    sub.add_argument('--ticket', required=True)
    sub.add_argument('--stage', required=True, choices=sorted(STAGES))
    sub.add_argument('--evidence', required=True, action='append',
                     help='commit, gate and/or file; comma-separated or repeated')
    sub.add_argument('--depends', help='comma-separated item numbers')
    sub.add_argument('--follows', type=int, help='item this one continues')
    sub.add_argument('--deadline', help='ISO 8601 or +N[m|h|d]')
    sub.add_argument('--branch', help='branch the commit evidence must reach')
    sub.add_argument('--repo', help='absolute path of the git repo the commit evidence lives in')
    sub = command('assign', 'Give an item to an agent')
    sub.add_argument('--agent', required=True, help='HCOM name, stored as the full name')
    sub.add_argument('--native', action='store_true',
                     help='Claude built-in agent without an HCOM name: --agent is kept as given')
    sub.add_argument('--card', required=True, help='task card path')
    sub.add_argument('--deadline', help='required unless add set one')
    sub = command('start', 'Agent starts work')
    sub.add_argument('--eta', required=True, help='expected finish: ISO 8601 or +N[m|h|d]')
    sub = command('update', 'Record progress or change times, card or dependencies')
    sub.add_argument('--eta')
    sub.add_argument('--deadline')
    sub.add_argument('--progress')
    sub.add_argument('--card')
    sub.add_argument('--branch', help='branch the commit evidence must reach')
    sub.add_argument('--depends', help='replace dependencies; empty string clears them')
    sub.add_argument('--reason')
    sub = command('block', 'Mark an item blocked')
    sub.add_argument('--reason', required=True, help='what it waits for')
    sub = command('unblock', 'Resume a blocked item')
    sub.add_argument('--reason')
    sub = command('done', 'Close an item with evidence')
    sub.add_argument('--commit', action='append')
    sub.add_argument('--repo', help='git repo to verify --commit in (absolute; replaces the '
                     "row's repo). Refused when it is not a git repo or lacks the commit; the "
                     "row's branch and the integration branch must contain the commit where "
                     'they exist in that repo, otherwise only its existence is checked')
    sub.add_argument('--gate', action='append', help='suite-gate record fingerprint')
    sub.add_argument('--file', action='append', help='absolute path of a report or checklist')
    sub = command('cancel', 'Cancel an item (orchestrator only)')
    sub.add_argument('--reason', required=True)
    sub = command('reassign', 'Hand an open item to another agent')
    sub.add_argument('--agent', required=True, help='HCOM name, stored as the full name')
    sub.add_argument('--native', action='store_true',
                     help='Claude built-in agent without an HCOM name: --agent is kept as given')
    sub.add_argument('--card')
    sub.add_argument('--reason', required=True)
    for name, text in (('next', 'Items ready to dispatch'), ('check', 'Verify every item'),
                       ('show', 'Print the ledger')):
        command(name, text, item=False).add_argument('--json', action='store_true')
    sub = command('repair', 'Accept a hand edit or rebuild from the journal', item=False)
    sub.add_argument('--reason', required=True)
    sub.add_argument('--from-journal', action='store_true')
    return parser


def main():
    args = build_parser().parse_args()
    handlers = {'init': cmd_init, 'add': cmd_add, 'assign': cmd_assign, 'start': cmd_start,
                'update': cmd_update, 'block': cmd_block, 'unblock': cmd_unblock,
                'done': cmd_done, 'cancel': cmd_cancel, 'reassign': cmd_reassign,
                'next': cmd_next, 'check': cmd_check, 'show': cmd_show, 'repair': cmd_repair}
    try:
        if args.command not in READ_ONLY:
            resolve_names(args)
        return handlers[args.command](args) or 0
    except (Failure, ValueError, OSError) as error:
        print(f'lat-ledger: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
